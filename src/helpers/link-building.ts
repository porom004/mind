// ── Link-building helpers ──

import type { LinkedMemorySummary, MindStore } from '../store/mind-store';

/**
 * Enriched link format returned by checkpoint_load and memory_read.
 */
export interface EnrichedLink {
  name: string;
  space: string;
  ref: string;
  tier: number;
  tags: string[];
  pinned: boolean;
  changed_at: string;
}

/**
 * Result of building linked memories for checkpoint tools.
 */
export interface LinkedMemoriesResult {
  links_to: EnrichedLink[];
  linked_by: EnrichedLink[];
}

/**
 * Transform a single LinkedMemorySummary to EnrichedLink format.
 */
export function transformLinkedSummary(summary: LinkedMemorySummary): EnrichedLink {
  return {
    name: summary.name,
    space: summary.space_name,
    ref: `${summary.space_name}:${summary.name}`,
    tier: summary.tier,
    tags: summary.tags,
    pinned: summary.pinned,
    changed_at: summary.changed_at,
  };
}

/**
 * Transform linked memory summaries from getLinkedMemorySummaries() to the
 * enriched { links_to, linked_by } response format used by memory_read.
 */
export function mapLinkedSummariesToLinksFormat(summaries: {
  links_to: LinkedMemorySummary[];
  linked_by: LinkedMemorySummary[];
}): LinkedMemoriesResult {
  return {
    links_to: summaries.links_to.map(transformLinkedSummary),
    linked_by: summaries.linked_by.map(transformLinkedSummary),
  };
}

/**
 * Build an enriched linked_memories array for a checkpoint, using the store's
 * getLinks() and getMemoryById() to fetch linked memory details.
 *
 * Used by checkpoint_load (MCP) and recover (CLI) handlers.
 */
export function buildLinkedMemoriesArray(
  store: MindStore,
  memoryId: string,
  limit?: number
): EnrichedLink[] {
  const linked_memories: EnrichedLink[] = [];
  const links = store.getLinks(memoryId);
  const linksToInclude = typeof limit === 'number' ? links.slice(0, limit) : links;

  for (const link of linksToInclude) {
    const linkedMem = store.getMemoryById(link.target_id);
    if (linkedMem) {
      linked_memories.push({
        name: linkedMem.name,
        space: linkedMem.space_name,
        ref: `${linkedMem.space_name}:${linkedMem.name}`,
        tier: linkedMem.tier,
        tags: linkedMem.tags,
        pinned: linkedMem.pinned,
        changed_at: linkedMem.changed_at,
      });
    }
  }

  return linked_memories;
}
