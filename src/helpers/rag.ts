import { CONFIG } from '../config';

export type EmbeddingVector = number[];

export function isRagEnabled(): boolean {
  return CONFIG.rag.enabled && !!CONFIG.rag.apiKey;
}

export async function getEmbedding(text: string): Promise<EmbeddingVector | null> {
  if (!isRagEnabled()) {
    return null;
  }

  const maxAttempts = 3;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const response = await fetch('https://api.openai.com/v1/embeddings', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${CONFIG.rag.apiKey}`,
        },
        body: JSON.stringify({
          model: CONFIG.rag.model,
          input: text,
        }),
      });

      if (!response.ok) {
        const errMsg = `OpenAI API error: ${response.status} ${response.statusText}`;
        const isLast = attempt === maxAttempts;
        if (isLast) {
          console.error(`[RAG] ${errMsg} (attempt ${attempt}/${maxAttempts}) — giving up`);
        } else {
          console.warn(`[RAG] ${errMsg} (attempt ${attempt}/${maxAttempts}) — retrying...`);
        }
        if (isLast) return null;
        await new Promise(r => setTimeout(r, 1000 * attempt));
        continue;
      }

      const data = (await response.json()) as {
        data: { embedding: number[] }[];
      };

      return data.data[0]?.embedding ?? null;
    } catch (e: any) {
      const isLast = attempt === maxAttempts;
      if (isLast) {
        console.error(
          `[RAG] Failed to get embedding: ${e.message} (attempt ${attempt}/${maxAttempts}) — giving up`
        );
      } else {
        console.warn(
          `[RAG] Failed to get embedding: ${e.message} (attempt ${attempt}/${maxAttempts}) — retrying...`
        );
      }
      if (isLast) return null;
      await new Promise(r => setTimeout(r, 1000 * attempt));
    }
  }

  return null;
}

export function cosineSimilarity(a: EmbeddingVector, b: EmbeddingVector): number {
  if (a.length !== b.length) {
    throw new Error(`Vector dimension mismatch: ${a.length} vs ${b.length}`);
  }

  let dotProduct = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i]! * b[i]!;
    normA += a[i]! * a[i]!;
    normB += b[i]! * b[i]!;
  }

  const denominator = Math.sqrt(normA) * Math.sqrt(normB);
  if (denominator === 0) {
    return 0;
  }

  return dotProduct / denominator;
}

export interface ScoredMemory {
  id: string;
  score: number;
}

export async function semanticSearch(
  query: string,
  getMemoryEmbedding: (_id: string) => Float32Array | null,
  memoryIds: string[]
): Promise<ScoredMemory[]> {
  const queryEmbedding = await getEmbedding(query);
  if (!queryEmbedding) {
    return [];
  }

  const results: ScoredMemory[] = [];

  for (const id of memoryIds) {
    const memEmbedding = getMemoryEmbedding(id);
    if (!memEmbedding) {
      continue;
    }

    // Convert Float32Array to number[] for cosineSimilarity
    const vec = Array.from(memEmbedding);
    const score = cosineSimilarity(queryEmbedding, vec);
    results.push({ id, score });
  }

  // Sort by score descending
  results.sort((a, b) => b.score - a.score);

  return results;
}

export function vectorToBlob(vector: EmbeddingVector): Uint8Array {
  const buffer = new Float32Array(vector).buffer;
  return new Uint8Array(buffer);
}

export function blobToVector(blob: Uint8Array): Float32Array {
  return new Float32Array(blob.buffer);
}
