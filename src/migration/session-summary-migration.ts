import {
  buildOfficialSessionSummaryContent,
  buildSessionSummaryName,
  isSessionLikeMemory,
  SESSION_SUMMARY_TAGS,
  SESSION_SUMMARY_TIER,
} from '../helpers/session-summary';
import type { MindStore } from '../store/mind-store';
import type { Memory, MemorySummary } from '../types';

export interface SessionSummaryMigrationItem {
  sourceName: string;
  targetName: string;
}

export interface SessionSummaryMigrationReport {
  dryRun: boolean;
  sourceSpace: string;
  targetSpace: string;
  migrated: SessionSummaryMigrationItem[];
  skipped: SessionSummaryMigrationItem[];
}

function getLegacySessionSpace(projectSpace: string): string {
  return projectSpace.startsWith('projects/')
    ? `sessions/${projectSpace.slice('projects/'.length)}`
    : `sessions/${projectSpace}`;
}

function parseJsonObject(raw: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function buildProvenanceContent(memory: Memory): string {
  const parsed = parseJsonObject(memory.content);
  const resolvedTimestamp = resolveTimestamp(memory);

  return buildOfficialSessionSummaryContent({
    writer: 'session_summary_migration',
    base: parsed
      ? {
          ...parsed,
          createdAt: typeof parsed.createdAt === 'string' ? parsed.createdAt : resolvedTimestamp,
          updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : resolvedTimestamp,
        }
      : {
          createdAt: resolvedTimestamp,
          updatedAt: resolvedTimestamp,
        },
    whatWasDone:
      (typeof parsed?.whatWasDone === 'string' && parsed.whatWasDone) ||
      (typeof parsed?.summary === 'string' && parsed.summary) ||
      memory.content,
    completedAt:
      (typeof parsed?.completedAt === 'string' && parsed.completedAt) || resolvedTimestamp,
    provenance: {
      migrated_from_space: memory.space_name,
      migrated_from_name: memory.name,
      migrated_from_tags: memory.tags,
    },
  });
}

function resolveTimestamp(memory: Memory): string {
  const parsed = parseJsonObject(memory.content);
  const candidate =
    (typeof parsed?.completedAt === 'string' && parsed.completedAt) ||
    (typeof parsed?.updatedAt === 'string' && parsed.updatedAt) ||
    (typeof parsed?.createdAt === 'string' && parsed.createdAt) ||
    memory.changed_at;

  return candidate;
}

function resolveTargetName(store: MindStore, targetSpace: string, memory: Memory): string {
  const baseName = memory.name.startsWith('session-')
    ? memory.name
    : buildSessionSummaryName(resolveTimestamp(memory), memory.name);
  const existing = store.getMemory(targetSpace, baseName);

  if (!existing || existing.id === memory.id) {
    return baseName;
  }

  return `${baseName}-${memory.id}`;
}

async function fetchLegacySessionSummaries(
  store: MindStore,
  sourceSpace: string
): Promise<MemorySummary[]> {
  const total = await store.queryMemoriesCount({
    space: sourceSpace,
  });

  const summaries: MemorySummary[] = [];
  for (let offset = 0; offset < total; offset += 500) {
    const batch = store.queryMemories({
      space: sourceSpace,
      limit: 500,
      offset,
    });

    for (const summary of batch) {
      const fullMemory = store.getMemoryById(summary.id);
      if (fullMemory && isSessionLikeMemory(fullMemory)) {
        summaries.push(summary);
      }
    }
  }

  return summaries;
}

export async function migrateLegacySessionSummaries(
  store: MindStore,
  args: { projectSpace: string; dryRun?: boolean }
): Promise<SessionSummaryMigrationReport> {
  const targetSpace = args.projectSpace;
  const sourceSpace = getLegacySessionSpace(targetSpace);
  const dryRun = args.dryRun ?? false;

  const report: SessionSummaryMigrationReport = {
    dryRun,
    sourceSpace,
    targetSpace,
    migrated: [],
    skipped: [],
  };

  if (!store.getSpace(sourceSpace)) {
    return report;
  }

  if (!store.getSpace(targetSpace) && !dryRun) {
    store.createSpace(targetSpace, `Migrated project continuity for ${targetSpace}`, [
      'type:project',
    ]);
  }

  const legacySummaries = await fetchLegacySessionSummaries(store, sourceSpace);
  for (const summary of legacySummaries) {
    const fullMemory = store.getMemoryById(summary.id);
    if (!fullMemory) {
      report.skipped.push({ sourceName: summary.name, targetName: summary.name });
      continue;
    }

    const targetName = resolveTargetName(store, targetSpace, fullMemory);
    report.migrated.push({
      sourceName: fullMemory.name,
      targetName,
    });

    if (dryRun) {
      continue;
    }

    await store.moveMemory(fullMemory.id, {
      space: targetSpace,
      name: targetName,
      content: buildProvenanceContent(fullMemory),
      tier: SESSION_SUMMARY_TIER,
    });
    store.setMemoryTags(fullMemory.id, [...SESSION_SUMMARY_TAGS]);
  }

  return report;
}
