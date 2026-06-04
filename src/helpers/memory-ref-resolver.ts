import type { MindStore } from '../store/mind-store';

export function resolveRefWithFallback(
  store: MindStore,
  ref: string,
  fallbackSpace?: string
): { id: string; space: string; name: string } {
  const parsed = store.resolveMemoryRef(ref);

  if (parsed) {
    const memory = store.getMemory(parsed.space, parsed.name);
    if (!memory) {
      throw new Error(`memory not found: ${ref}`);
    }
    return { id: memory.id, space: parsed.space, name: memory.name };
  }

  if (fallbackSpace) {
    const memory = store.getMemory(fallbackSpace, ref);
    if (memory) {
      return { id: memory.id, space: fallbackSpace, name: memory.name };
    }
  }

  const spaces = store.listSpaces();
  for (const spaceSummary of spaces) {
    const memory = store.getMemory(spaceSummary.name, ref);
    if (memory) {
      return { id: memory.id, space: spaceSummary.name, name: memory.name };
    }
  }

  if (!ref.includes(':')) {
    throw new Error('invalid memory reference');
  }

  throw new Error(`memory not found: ${ref}`);
}
