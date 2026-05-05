import type { MindStore } from '../../store/mind-store';
import { doneCheckpointHandler } from '../handlers/checkpoint/done-checkpoint';
import { loadCheckpointHandler } from '../handlers/checkpoint/load-checkpoint';
import { queryCheckpointsHandler } from '../handlers/checkpoint/query-checkpoints';
import { saveCheckpointHandler } from '../handlers/checkpoint/save-checkpoint';
import { CheckpointDoneSchema } from '../schemas/checkpoint/done-checkpoint';
import { CheckpointLoadSchema } from '../schemas/checkpoint/load-checkpoint';
import { CheckpointQuerySchema } from '../schemas/checkpoint/query-checkpoints';
import { CheckpointSaveSchema } from '../schemas/checkpoint/save-checkpoint';
import type { ToolDefinition } from '../tool-types';

const CHECKPOINT_TOOL_DESCRIPTIONS: Record<string, string> = {
  checkpoint_save:
    'Save or update a session checkpoint (goal, pending, notes, linked_memories). Creates a recoverable snapshot for context resets or compaction.',
  checkpoint_done:
    'Complete a checkpoint and transform it into a same-space `session-*` T3 summary memory in projects/<repo>. The checkpoint is deleted after the summary is created.',
  checkpoint_load:
    'Restore a specific checkpoint by name. Returns checkpoint state and linked_memories in enriched format.',
  checkpoint_query:
    'Find checkpoints by status, date range, or tag. Returns checkpoint summaries with pagination.',
};

export interface CheckpointTools {
  checkpoint_save: ToolDefinition;
  checkpoint_done: ToolDefinition;
  checkpoint_load: ToolDefinition;
  checkpoint_query: ToolDefinition;
}

export function createCheckpointTools(store: MindStore): CheckpointTools {
  return {
    checkpoint_save: {
      schema: CheckpointSaveSchema,
      description: CHECKPOINT_TOOL_DESCRIPTIONS.checkpoint_save,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
      handler: saveCheckpointHandler(store),
    },
    checkpoint_done: {
      schema: CheckpointDoneSchema,
      description: CHECKPOINT_TOOL_DESCRIPTIONS.checkpoint_done,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
      handler: doneCheckpointHandler(store),
    },
    checkpoint_load: {
      schema: CheckpointLoadSchema,
      description: CHECKPOINT_TOOL_DESCRIPTIONS.checkpoint_load,
      annotations: { readOnlyHint: true },
      handler: loadCheckpointHandler(store),
    },
    checkpoint_query: {
      schema: CheckpointQuerySchema,
      description: CHECKPOINT_TOOL_DESCRIPTIONS.checkpoint_query,
      annotations: { readOnlyHint: true },
      handler: queryCheckpointsHandler(store),
    },
  };
}
