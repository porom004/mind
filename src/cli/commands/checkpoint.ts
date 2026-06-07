// ── Checkpoint CLI command handlers ──

import { completeCheckpoint } from '../../checkpoint/checkpoint-done';
import { buildCheckpointContent, fetchCheckpointContent } from '../../helpers/checkpoint-content';
import type { CheckpointContent } from '../../helpers/checkpoint-content';
import { buildLinkedMemoriesArray } from '../../helpers/link-building';
import type { EnrichedLink } from '../../helpers/link-building';
import { resolveRefWithFallback } from '../../helpers/memory-ref-resolver';
import { style } from '../../helpers/style';
import type { MindStore } from '../../store/mind-store';
import type { Memory } from '../../types';
import { ArgParser } from '../arg-parser';

import type { CommandGroup } from './types';

const p = ArgParser.param.bind(ArgParser);

// ── Helper functions ──

/**
 * Parse comma-separated memory refs and create links from the checkpoint memory.
 * Silently skips unresolvable refs.
 */
function linkMemoriesToCheckpoint(
  store: MindStore,
  checkpointId: string,
  linkedMemoriesFlag: string,
  space: string
): void {
  const refs = linkedMemoriesFlag
    .split(',')
    .map(r => r.trim())
    .filter(Boolean);

  for (const ref of refs) {
    try {
      const resolved = resolveRefWithFallback(store, ref, space);
      store.link(checkpointId, resolved.id, 'related');
    } catch {
      // Ignore link errors silently
    }
  }
}

/**
 * Build a recoverable checkpoint object from a checkpoint memory.
 */
function buildRecoverableCheckpoint(
  checkpointMemory: Memory,
  linked_memories: EnrichedLink[],
  checkpointContent: CheckpointContent | null
) {
  return {
    space: checkpointMemory.space_name,
    name: checkpointMemory.name,
    tier: checkpointMemory.tier,
    tags: checkpointMemory.tags,
    content: checkpointContent,
    linked_memories,
    updated_at: checkpointMemory.updated_at,
  };
}

const SET = new ArgParser(
  ['checkpoint set|cp set', p('space'), p('goal'), p('pending')],
  'Creates or updates a checkpoint for the current work session',
  [
    { name: 'notes', alias: 'n', hasValue: true },
    { name: 'linked-memories', alias: 'l', hasValue: true },
  ]
);

const COMPLETE = new ArgParser(
  ['checkpoint complete|cp complete|checkpoint done|cp done', p('space'), p('name'), p('what')],
  'Marks a checkpoint as completed',
  []
);

const RECOVER = new ArgParser(
  ['checkpoint recover|cp recover', p('space')],
  'Recovers a checkpoint by name (use checkpoint list to find available checkpoints)',
  [{ name: 'name', alias: 'n', hasValue: true }]
);

const LIST = new ArgParser(
  ['checkpoint list|cp list', p('space')],
  'Lists all checkpoints for a space',
  [{ name: 'status', alias: 'S', hasValue: true }]
);

export const checkpointGroup: CommandGroup = {
  name: 'Checkpoint',
  helpEntries: [SET, COMPLETE, RECOVER, LIST],
  commands: [
    {
      matches: args => SET.matches(args),
      execute: async (args, store, logger) => {
        const params = SET.getParams(args);
        const flags = SET.getFlags(args);
        const space = params.space;
        const goal = params.goal;
        const pending = params.pending;
        const notes = flags.notes ? String(flags.notes) : undefined;
        const linkedMemoriesFlag = flags['linked-memories']
          ? String(flags['linked-memories'])
          : undefined;

        // Verify the space exists
        if (!store.getSpace(space)) {
          logger.logInfo(style(`❌ Space "${space}" not found`, ['red']));
          return;
        }

        // Check if there's already an active checkpoint
        const existingCheckpoints = store.listMemories(space, { tag: 'checkpoint' });
        const activeCheckpoint = existingCheckpoints.find(m => m.tags.includes('active'));

        let checkpoint;
        if (activeCheckpoint) {
          // Update existing active checkpoint
          const memory = store.getMemoryById(activeCheckpoint.id);
          if (memory) {
            const existingContent = fetchCheckpointContent(memory);
            if (existingContent) {
              await store.updateMemory(activeCheckpoint.id, {
                content: buildCheckpointContent(
                  goal,
                  pending,
                  notes || '',
                  existingContent.createdAt
                ),
              });
              checkpoint = store.getMemoryById(activeCheckpoint.id);
            }
          }
        } else {
          // Create new checkpoint
          const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
          checkpoint = await store.addMemory(
            space,
            `checkpoint-${timestamp}`,
            buildCheckpointContent(goal, pending, notes || ''),
            {
              tags: ['checkpoint', 'active'],
              tier: 1,
            }
          );
        }

        // Link comma-separated refs to the checkpoint using shared helper
        if (linkedMemoriesFlag && checkpoint) {
          linkMemoriesToCheckpoint(store, checkpoint.id, linkedMemoriesFlag, space);
        }

        const status = activeCheckpoint ? 'updated' : 'created';
        logger.logInfo(style(`Checkpoint ${status} in "${space}"`, ['bold', 'green']));
        if (checkpoint) {
          logger.logInfo(style(`   Name: ${checkpoint.name}`, ['dim']));
        }
      },
    },
    {
      matches: args => COMPLETE.matches(args),
      execute: async (args, store, logger) => {
        const params = COMPLETE.getParams(args);
        const space = params.space;
        const checkpointName = params.name;
        const summary = params.what ?? '';

        let memory;
        if (checkpointName) {
          memory = store.getMemory(space, checkpointName);
        } else {
          // Find active checkpoint
          const checkpoints = store.listMemories(space, { tag: 'checkpoint' });
          const active = checkpoints.find(m => m.tags.includes('active'));
          if (active) {
            memory = store.getMemoryById(active.id);
          }
        }

        if (!memory) {
          logger.logInfo(style(`Checkpoint not found in "${space}"`, ['red']));
          return;
        }

        // Transform checkpoint into session memory (same behavior as MCP checkpoint_done)
        const result = await completeCheckpoint(store, space, memory.id, summary);

        logger.logInfo(
          style(
            `Checkpoint transformed into session memory "${result.sessionMemory.name}" in "${result.sessionMemory.space}"`,
            ['bold', 'green']
          )
        );
      },
    },
    {
      matches: args => RECOVER.matches(args),
      execute: async (args, store, logger) => {
        const params = RECOVER.getParams(args);
        const flags = RECOVER.getFlags(args);
        const space = params.space;
        const checkpointName = flags.name ? String(flags.name) : undefined;

        if (!checkpointName) {
          logger.logInfo(
            style(
              'Checkpoint name is required. Use "checkpoint list" first to find available checkpoints.',
              ['yellow']
            )
          );
          return;
        }

        // Find checkpoint by name
        let checkpointMemory = store.getMemory(space, checkpointName);
        if (!checkpointMemory) {
          logger.logInfo(style(`Checkpoint "${checkpointName}" not found in "${space}"`, ['red']));
          return;
        }
        checkpointMemory = store.getMemoryById(checkpointMemory.id);
        if (!checkpointMemory) {
          logger.logInfo(style(`Checkpoint "${checkpointName}" could not be loaded`, ['red']));
          return;
        }

        // Use shared helpers for building linked_memories and parsing content
        const linked_memories = buildLinkedMemoriesArray(store, checkpointMemory.id, 5);
        const checkpointContent = fetchCheckpointContent(checkpointMemory);
        const checkpoint = buildRecoverableCheckpoint(
          checkpointMemory,
          linked_memories,
          checkpointContent
        );

        logger.logInfo(JSON.stringify(checkpoint, null, 2));
      },
    },
    {
      matches: args => LIST.matches(args),
      execute: async (args, store, logger) => {
        const params = LIST.getParams(args);
        const flags = LIST.getFlags(args);
        const space = params.space;
        const status = flags.status ? String(flags.status) : undefined;

        if (!store.getSpace(space)) {
          logger.logInfo(style(`No checkpoint space found for "${space}"`, ['yellow']));
          return;
        }

        // Get all checkpoints
        let checkpoints = store.listMemories(space, { tag: 'checkpoint' });

        // Filter by status if specified
        if (status && status !== 'all') {
          checkpoints = checkpoints.filter(m => m.tags.includes(status));
        }

        // Sort by updated_at descending
        checkpoints.sort(
          (a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime()
        );

        if (checkpoints.length === 0) {
          logger.logInfo(style(`No checkpoints found`, ['yellow']));
          return;
        }

        logger.logInfo(style(`Checkpoints for "${space}":`, ['bold', 'cyan']));
        for (const cp of checkpoints) {
          const statusBadge = cp.tags.includes('active')
            ? style(' [active]', ['green'])
            : style(' [completed]', ['dim']);
          logger.logInfo(style(`   ${cp.name}${statusBadge}`, []));
          logger.logInfo(style(`       Updated: ${cp.updated_at}`, ['dim']));
        }
      },
    },
  ],
};
