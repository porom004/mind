import type { Memory, MemorySummary, Tier } from '../types';

export const SESSION_SUMMARY_TAGS = ['type:session', 'cat:summary'] as const;
export const SESSION_SUMMARY_TIER: Tier = 3;
export const OFFICIAL_SESSION_SUMMARY_SCHEMA = 'mind.session-summary/v1' as const;
const SESSION_LIKE_FIELDS = ['whatWasDone', 'completedAt', 'originalCheckpoint'] as const;

type JsonObject = Record<string, unknown>;

export interface OfficialSessionSummaryContentArgs {
  writer: string;
  base?: JsonObject;
  whatWasDone?: string;
  completedAt?: string;
  originalCheckpoint?: string;
  provenance?: JsonObject;
}

function sanitizeSegment(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function parseJsonObject(raw?: string | null): JsonObject | null {
  if (!raw) {
    return null;
  }

  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as JsonObject)
      : null;
  } catch {
    return null;
  }
}

function ensureStringField(content: JsonObject, key: string, fallback = ''): void {
  if (typeof content[key] !== 'string') {
    content[key] = fallback;
  }
}

function hasNonEmptyStringField(content: JsonObject, key: string): boolean {
  return typeof content[key] === 'string' && String(content[key]).trim().length > 0;
}

export function buildOfficialSessionSummaryContent(
  args: OfficialSessionSummaryContentArgs
): string {
  const content: JsonObject = { ...(args.base ?? {}) };

  ensureStringField(content, 'goal');
  ensureStringField(content, 'pending');
  ensureStringField(content, 'notes');
  ensureStringField(content, 'createdAt');
  ensureStringField(content, 'updatedAt');

  if (args.whatWasDone !== undefined || typeof content.whatWasDone !== 'string') {
    content.whatWasDone = args.whatWasDone ?? '';
  }

  if (args.completedAt !== undefined || typeof content.completedAt !== 'string') {
    content.completedAt = args.completedAt ?? '';
  }

  if (args.originalCheckpoint !== undefined) {
    content.originalCheckpoint = args.originalCheckpoint;
  } else if (
    Object.prototype.hasOwnProperty.call(content, 'originalCheckpoint') &&
    typeof content.originalCheckpoint !== 'string'
  ) {
    delete content.originalCheckpoint;
  }

  content.sessionSummary = {
    schema: OFFICIAL_SESSION_SUMMARY_SCHEMA,
    writer: {
      id: args.writer,
    },
    provenance: args.provenance ?? {},
  };

  return JSON.stringify(content, null, 2);
}

type SessionLikeCandidate = Pick<MemorySummary, 'name' | 'tags'> & {
  content?: string | null;
};

function isOfficialSessionSummaryPayload(content: JsonObject | null): boolean {
  const metadata = content?.sessionSummary;
  return (
    Boolean(metadata && typeof metadata === 'object' && !Array.isArray(metadata)) &&
    (metadata as JsonObject).schema === OFFICIAL_SESSION_SUMMARY_SCHEMA
  );
}

export function isSessionLikeMemory(
  candidate: SessionLikeCandidate | Pick<Memory, 'name' | 'tags' | 'content'>
): boolean {
  const tags = candidate.tags ?? [];

  if (tags.includes('checkpoint')) {
    return false;
  }

  if (candidate.name.startsWith('session-')) {
    return true;
  }

  if (tags.includes('type:session') || tags.includes('cat:summary')) {
    return true;
  }

  const parsed = parseJsonObject(candidate.content);
  if (isOfficialSessionSummaryPayload(parsed)) {
    return true;
  }

  return Boolean(parsed && SESSION_LIKE_FIELDS.some(key => hasNonEmptyStringField(parsed, key)));
}

export function formatSessionSummaryTimestamp(value?: string | Date): string {
  const date = value instanceof Date ? value : new Date(value ?? Date.now());
  if (Number.isNaN(date.getTime())) {
    return 'unknown';
  }

  return date
    .toISOString()
    .replace(/\.\d{3}Z$/, 'Z')
    .replace(/[:]/g, '-');
}

export function buildSessionSummaryName(timestamp?: string | Date, sourceName?: string): string {
  const base = `session-${formatSessionSummaryTimestamp(timestamp)}`;
  const suffix = sourceName ? sanitizeSegment(sourceName) : '';
  return suffix && !sourceName?.startsWith('session-') ? `${base}-${suffix}` : base;
}
