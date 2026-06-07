import { resolveRefWithFallback } from '../../../helpers/memory-ref-resolver';
import type { MindStore } from '../../../store/mind-store';
import type { Tier } from '../../../types';
import { presentMemoryResponse } from '../../helpers/memory-response';
import { buildYamlContent } from '../../helpers/yaml-response';
import { MemoryAddSchema } from '../../schemas/memories/add-memory';

export function addMemoryHandler(store: MindStore) {
  return async (args: unknown) => {
    let parsed;

    try {
      parsed = MemoryAddSchema.parse(args);
    } catch (e: any) {
      const msg = e.message || '';
      const isTagsError = (e.issues || []).some((issue: { path: string[] }) =>
        issue.path.includes('tags')
      );
      if (isTagsError && msg.includes('tags')) {
        throw new Error('tags is required and must be a non-empty array');
      }
      throw new Error(
        `Invalid arguments: ${e.message}. Provide: space, name, content, tags (required, min 1), tier (optional), pinned (optional), links_to (optional, "space:name" refs).`
      );
    }

    const linksCreated: Array<{ source: string; target: string; label: string }> = [];
    const linksFailed: Array<{ ref: string; reason: string }> = [];
    let linksToIds: string[] | undefined;

    if (parsed.links_to && parsed.links_to.length > 0) {
      linksToIds = [];
      for (const ref of parsed.links_to) {
        try {
          const resolved = resolveRefWithFallback(store, ref, parsed.space);
          linksToIds.push(resolved.id);
          linksCreated.push({
            source: parsed.name,
            target: resolved.name,
            label: 'related',
          });
        } catch (e: any) {
          linksFailed.push({
            ref,
            reason: e.message || 'unknown error',
          });
        }
      }
    }

    const memory = await store.addMemory(parsed.space, parsed.name, parsed.content, {
      tags: parsed.tags,
      tier: parsed.tier as Tier | undefined,
      pinned: parsed.pinned,
      linksToIds: linksToIds && linksToIds.length > 0 ? linksToIds : undefined,
    });

    return buildYamlContent({
      memory: presentMemoryResponse(memory),
      links_created: linksCreated,
      links_failed: linksFailed,
    });
  };
}
