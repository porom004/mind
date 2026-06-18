// ── SearchRepository: handles all search operations ──

import type { Database } from 'bun:sqlite';

import { blobToVector, isRagEnabled, semanticSearch } from '../../helpers/rag';
import { normalizeTag } from '../../helpers/tags';
import type { MemoryQueryFilter, MemorySummary, SearchResult, Tier } from '../../types';
import { normalizeDateBound, sanitizeFtsQuery } from '../shared';

import type { MemoryRepository } from './memory-repository';
import type { TagRepository } from './tag-repository';

export interface SearchRepository {
  searchMemories(
    query: string,
    filter?: { space?: string; tag?: string; tier?: Tier }
  ): Promise<SearchResult[]>;
  searchFallback(
    query: string,
    filter?: { space?: string; tag?: string; tier?: Tier }
  ): Promise<{ results: SearchResult[]; search_method: string }>;
  searchFts5(
    query: string,
    filter?: { space?: string; tag?: string; tier?: Tier }
  ): Promise<SearchResult[]>;
  searchLike(query: string, filter?: { space?: string; tag?: string; tier?: Tier }): SearchResult[];
  searchSemantic(
    query: string,
    filter?: { space?: string; tag?: string; tier?: Tier }
  ): Promise<SearchResult[]>;
  queryMemories(filter?: MemoryQueryFilter): MemorySummary[];
  queryMemoriesCount(filter: {
    space?: string;
    tag?: string;
    tier?: number;
    from?: string;
    to?: string;
  }): Promise<number>;
  getSpaceGraph(
    space: string,
    opts?: { limit?: number; maxLimit?: number }
  ): {
    nodes: { id: string; name: string; tier: Tier; links_to: string[]; linked_by: string[] }[];
    meta: {
      total_nodes: number;
      returned_nodes: number;
      requested_limit: number;
      applied_limit: number;
      max_limit: number;
      truncated: boolean;
    };
  };
}

function getTagsForMemory(db: Database, memoryId: string): string[] {
  const rows = db.query('SELECT tag FROM memory_tags WHERE memory_id = ?').all(memoryId) as {
    tag: string;
  }[];
  return rows.map(r => r.tag);
}

export function createSearchRepository(
  db: Database,
  _memoryRepo: MemoryRepository,
  _tagRepo: TagRepository
): SearchRepository {
  async function searchMemories(
    query: string,
    filter?: { space?: string; tag?: string; tier?: Tier }
  ): Promise<SearchResult[]> {
    const sanitized = sanitizeFtsQuery(query);
    if (!sanitized) return [];

    let sql = `
            SELECT m.id, s.name as space_name, m.name, m.content, m.tier, m.pinned,
                   m.created_at, m.updated_at, m.changed_at, fts.rank
            FROM memories_fts fts
            JOIN memories m ON m.fts_id = fts.rowid
            JOIN spaces s ON s.id = m.space_id
            WHERE memories_fts MATCH ?
        `;
    const params: any[] = [sanitized];

    if (filter?.space) {
      sql += ' AND s.name = ?';
      params.push(filter.space);
    }
    if (filter?.tier) {
      sql += ' AND m.tier = ?';
      params.push(filter.tier);
    }

    sql += ' ORDER BY fts.rank';

    let rows = db.query(sql).all(...params) as any[];

    // Post-filter by tag (requires join)
    if (filter?.tag) {
      const normalizedTag = normalizeTag(filter.tag);
      rows = rows.filter(r => {
        const tags = getTagsForMemory(db, r.id);
        return tags.includes(normalizedTag);
      });
    }

    // If RAG is enabled, enrich and re-rank results with semantic similarity.
    // If FTS returned nothing, fall back to pure semantic search across all candidates.
    if (isRagEnabled()) {
      const normalizeScores = (values: number[]): number[] => {
        if (values.length === 0) return [];
        const min = Math.min(...values);
        const max = Math.max(...values);
        if (min === max) return values.map(() => 1);
        return values.map(value => (value - min) / (max - min));
      };

      const getEmbeddingForId = (id: string): Float32Array | null => {
        const row = db
          .query(
            'SELECT embedding FROM memories m JOIN spaces s ON s.id = m.space_id WHERE m.id = ?'
          )
          .get(id) as any;
        return row?.embedding ? blobToVector(row.embedding) : null;
      };

      // FTS returned results — re-rank by semantic similarity
      if (rows.length > 0) {
        const HYBRID_FTS_WEIGHT = 0.65;
        const HYBRID_SEMANTIC_WEIGHT = 0.35;
        const allIds = rows.map(r => r.id);
        const semanticResults = await semanticSearch(query, getEmbeddingForId, allIds);
        const semanticMap = new Map(semanticResults.map(sr => [sr.id, sr.score]));
        const rankMap = new Map(rows.map(row => [row.id, Number(row.rank) || 0]));

        const normalizedFts = normalizeScores(rows.map(row => -(Number(row.rank) || 0)));
        const normalizedSemantic = normalizeScores(rows.map(row => semanticMap.get(row.id) ?? 0));
        const hybridScore = new Map<number, number>();

        for (let index = 0; index < rows.length; index++) {
          const row = rows[index]!;
          const score =
            (normalizedFts[index] ?? 0) * HYBRID_FTS_WEIGHT +
            (normalizedSemantic[index] ?? 0) * HYBRID_SEMANTIC_WEIGHT;
          hybridScore.set(row.id, score);
        }

        // Re-rank by hybrid score (highest first), deterministic tie-breakers.
        rows.sort((a, b) => {
          const byHybrid = (hybridScore.get(b.id) ?? 0) - (hybridScore.get(a.id) ?? 0);
          if (byHybrid !== 0) return byHybrid;
          const byRank = (rankMap.get(a.id) ?? 0) - (rankMap.get(b.id) ?? 0);
          if (byRank !== 0) return byRank;
          return a.id - b.id;
        });

        return rows.map(r => ({
          id: r.id,
          space_name: r.space_name,
          name: r.name,
          content: r.content,
          tier: r.tier as Tier,
          pinned: r.pinned === 1,
          tags: getTagsForMemory(db, r.id),
          rank: r.rank,
          similarity: semanticMap.get(r.id) ?? undefined,
          created_at: r.created_at,
          updated_at: r.updated_at,
          changed_at: r.changed_at,
        }));
      }

      // FTS returned nothing — fall back to pure semantic search across all candidates
      const SEMANTIC_FALLBACK_THRESHOLD = 0.3;
      let candSql =
        'SELECT m.id, s.name as space_name, m.name, m.content, m.tier, m.pinned, m.created_at, m.updated_at, m.changed_at FROM memories m JOIN spaces s ON s.id = m.space_id WHERE 1=1';
      const candParams: any[] = [];
      if (filter?.space) {
        candSql += ' AND s.name = ?';
        candParams.push(filter.space);
      }
      if (filter?.tier) {
        candSql += ' AND tier = ?';
        candParams.push(filter.tier);
      }
      let candidates = db.query(candSql).all(...candParams) as any[];
      if (filter?.tag) {
        const normalizedTag = normalizeTag(filter.tag);
        candidates = candidates.filter(r => getTagsForMemory(db, r.id).includes(normalizedTag));
      }

      const allIds = candidates.map((r: any) => r.id);
      const semanticResults = await semanticSearch(query, getEmbeddingForId, allIds);
      const goodResults = semanticResults.filter(sr => sr.score >= SEMANTIC_FALLBACK_THRESHOLD);
      if (goodResults.length === 0) return [];

      const idToMem = new Map(candidates.map((r: any) => [r.id, r]));
      return goodResults.map(sr => {
        const r = idToMem.get(sr.id)!;
        return {
          id: r.id,
          space_name: r.space_name,
          name: r.name,
          content: r.content,
          tier: r.tier as Tier,
          pinned: r.pinned === 1,
          tags: getTagsForMemory(db, r.id),
          rank: 0,
          similarity: sr.score,
          created_at: r.created_at,
          updated_at: r.updated_at,
          changed_at: r.changed_at,
        };
      });
    }

    return rows.map(r => ({
      id: r.id,
      space_name: r.space_name,
      name: r.name,
      content: r.content,
      tier: r.tier as Tier,
      pinned: r.pinned === 1,
      tags: getTagsForMemory(db, r.id),
      rank: r.rank,
      similarity: undefined, // Only populated when RAG is enabled
      created_at: r.created_at,
      updated_at: r.updated_at,
      changed_at: r.changed_at,
    }));
  }

  async function searchFallback(
    query: string,
    filter?: { space?: string; tag?: string; tier?: Tier }
  ): Promise<{ results: SearchResult[]; search_method: string }> {
    // Step 1: Try FTS5
    let ftsResults = await searchFts5(query, filter);
    if (ftsResults.length > 0) {
      return { results: ftsResults, search_method: 'fts5' };
    }

    // Step 2: FTS returned nothing — try LIKE fallback
    let likeResults = searchLike(query, filter);
    if (likeResults.length > 0) {
      return { results: likeResults, search_method: 'like' };
    }

    // Step 3: If RAG enabled, try embeddings fallback
    if (isRagEnabled()) {
      const semanticResults = await searchSemantic(query, filter);
      if (semanticResults.length > 0) {
        return { results: semanticResults, search_method: 'embeddings' };
      }
    }

    return { results: [], search_method: 'fts5' };
  }

  async function searchFts5(
    query: string,
    filter?: { space?: string; tag?: string; tier?: Tier }
  ): Promise<SearchResult[]> {
    const sanitized = sanitizeFtsQuery(query);
    if (!sanitized) return [];

    let sql = `
            SELECT m.id, s.name as space_name, m.name, m.content, m.tier, m.pinned,
                   m.created_at, m.updated_at, m.changed_at, fts.rank
            FROM memories_fts fts
            JOIN memories m ON m.fts_id = fts.rowid
            JOIN spaces s ON s.id = m.space_id
            WHERE memories_fts MATCH ?
        `;
    const params: any[] = [sanitized];

    if (filter?.space) {
      sql += ' AND s.name = ?';
      params.push(filter.space);
    }
    if (filter?.tier) {
      sql += ' AND m.tier = ?';
      params.push(filter.tier);
    }

    sql += ' ORDER BY fts.rank';

    let rows = db.query(sql).all(...params) as any[];

    // Post-filter by tag
    if (filter?.tag) {
      const normalizedTag = normalizeTag(filter.tag);
      rows = rows.filter(r => {
        const tags = getTagsForMemory(db, r.id);
        return tags.includes(normalizedTag);
      });
    }

    return rows.map(r => ({
      id: r.id,
      space_name: r.space_name,
      name: r.name,
      content: r.content,
      tier: r.tier as Tier,
      pinned: r.pinned === 1,
      tags: getTagsForMemory(db, r.id),
      rank: r.rank,
      similarity: undefined,
      created_at: r.created_at,
      updated_at: r.updated_at,
      changed_at: r.changed_at,
    }));
  }

  function searchLike(
    query: string,
    filter?: { space?: string; tag?: string; tier?: Tier }
  ): SearchResult[] {
    // Simple LIKE-based search as fallback when FTS5 returns nothing
    const likePattern = `%${query}%`;

    let sql = `
            SELECT m.id, s.name as space_name, m.name, m.content, m.tier, m.pinned,
                   m.created_at, m.updated_at, m.changed_at
            FROM memories m
            JOIN spaces s ON s.id = m.space_id
            WHERE (m.name LIKE ? OR m.content LIKE ?)
        `;
    const params: any[] = [likePattern, likePattern];

    if (filter?.space) {
      sql += ' AND s.name = ?';
      params.push(filter.space);
    }
    if (filter?.tier) {
      sql += ' AND m.tier = ?';
      params.push(filter.tier);
    }

    sql += ' ORDER BY m.changed_at DESC, m.rowid DESC';

    let rows = db.query(sql).all(...params) as any[];

    // Post-filter by tag
    if (filter?.tag) {
      const normalizedTag = normalizeTag(filter.tag);
      rows = rows.filter(r => {
        const tags = getTagsForMemory(db, r.id);
        return tags.includes(normalizedTag);
      });
    }

    return rows.map(r => ({
      id: r.id,
      space_name: r.space_name,
      name: r.name,
      content: r.content,
      tier: r.tier as Tier,
      pinned: r.pinned === 1,
      tags: getTagsForMemory(db, r.id),
      rank: 0,
      similarity: undefined,
      created_at: r.created_at,
      updated_at: r.updated_at,
      changed_at: r.changed_at,
    }));
  }

  async function searchSemantic(
    query: string,
    filter?: { space?: string; tag?: string; tier?: Tier }
  ): Promise<SearchResult[]> {
    if (!isRagEnabled()) return [];

    const SEMANTIC_FALLBACK_THRESHOLD = 0.3;

    let candSql =
      'SELECT m.id, s.name as space_name, m.name, m.content, m.tier, m.pinned, m.created_at, m.updated_at, m.changed_at FROM memories m JOIN spaces s ON s.id = m.space_id WHERE 1=1';
    const candParams: any[] = [];
    if (filter?.space) {
      candSql += ' AND s.name = ?';
      candParams.push(filter.space);
    }
    if (filter?.tier) {
      candSql += ' AND tier = ?';
      candParams.push(filter.tier);
    }
    let candidates = db.query(candSql).all(...candParams) as any[];
    if (filter?.tag) {
      const normalizedTag = normalizeTag(filter.tag);
      candidates = candidates.filter(r => getTagsForMemory(db, r.id).includes(normalizedTag));
    }

    const getEmbeddingForId = (id: string): Float32Array | null => {
      const row = db
        .query('SELECT embedding FROM memories m JOIN spaces s ON s.id = m.space_id WHERE m.id = ?')
        .get(id) as any;
      return row?.embedding ? blobToVector(row.embedding) : null;
    };

    const allIds = candidates.map((r: any) => r.id);
    const semanticResults = await semanticSearch(query, getEmbeddingForId, allIds);
    const goodResults = semanticResults.filter(sr => sr.score >= SEMANTIC_FALLBACK_THRESHOLD);
    if (goodResults.length === 0) return [];

    const idToMem = new Map(candidates.map((r: any) => [r.id, r]));
    return goodResults.map(sr => {
      const r = idToMem.get(sr.id)!;
      return {
        id: r.id,
        space_name: r.space_name,
        name: r.name,
        content: r.content,
        tier: r.tier as Tier,
        pinned: r.pinned === 1,
        tags: getTagsForMemory(db, r.id),
        rank: 0,
        similarity: sr.score,
        created_at: r.created_at,
        updated_at: r.updated_at,
        changed_at: r.changed_at,
      };
    });
  }

  function queryMemories(filter?: MemoryQueryFilter): MemorySummary[] {
    let sql =
      'SELECT m.id, s.name as space_name, m.space_id, m.name, m.tier, m.pinned, m.access_count, m.created_at, m.updated_at, m.changed_at FROM memories m JOIN spaces s ON s.id = m.space_id';
    const joinParams: any[] = [];
    const conditions: string[] = [];
    const whereParams: any[] = [];

    if (filter?.tag) {
      sql += ' JOIN memory_tags mt ON mt.memory_id = m.id AND mt.tag = ?';
      joinParams.push(normalizeTag(filter.tag));
    }

    if (filter?.space) {
      conditions.push('s.name = ?');
      whereParams.push(filter.space);
    }

    if (filter?.tier !== undefined) {
      conditions.push('m.tier = ?');
      whereParams.push(filter.tier);
    }

    if (filter?.from) {
      conditions.push('m.changed_at >= ?');
      whereParams.push(normalizeDateBound(filter.from, false));
    }

    if (filter?.to) {
      conditions.push('m.changed_at <= ?');
      whereParams.push(normalizeDateBound(filter.to, true));
    }

    if (conditions.length > 0) {
      sql += ' WHERE ' + conditions.join(' AND ');
    }

    const limit = Math.max(1, Math.min(500, filter?.limit ?? 25));
    const offset = Math.max(0, filter?.offset ?? 0);

    sql += ' ORDER BY m.changed_at DESC, m.rowid DESC LIMIT ? OFFSET ?';
    const rows = db.query(sql).all(...joinParams, ...whereParams, limit, offset) as any[];

    return rows.map(r => ({
      id: r.id,
      space_id: r.space_id,
      space_name: r.space_name,
      name: r.name,
      tier: r.tier as Tier,
      pinned: r.pinned === 1,
      tags: getTagsForMemory(db, r.id),
      access_count: r.access_count,
      created_at: r.created_at,
      updated_at: r.updated_at,
      changed_at: r.changed_at,
    }));
  }

  async function queryMemoriesCount(filter: {
    space?: string;
    tag?: string;
    tier?: number;
    from?: string;
    to?: string;
  }): Promise<number> {
    let sql = 'SELECT COUNT(*) as count FROM memories m JOIN spaces s ON s.id = m.space_id';
    const joinParams: any[] = [];
    const conditions: string[] = [];
    const whereParams: any[] = [];

    if (filter?.tag) {
      sql += ' JOIN memory_tags mt ON mt.memory_id = m.id AND mt.tag = ?';
      joinParams.push(normalizeTag(filter.tag));
    }

    if (filter?.space) {
      conditions.push('s.name = ?');
      whereParams.push(filter.space);
    }

    if (filter?.tier !== undefined) {
      conditions.push('m.tier = ?');
      whereParams.push(filter.tier);
    }

    if (filter?.from) {
      conditions.push('m.changed_at >= ?');
      whereParams.push(normalizeDateBound(filter.from, false));
    }

    if (filter?.to) {
      conditions.push('m.changed_at <= ?');
      whereParams.push(normalizeDateBound(filter.to, true));
    }

    if (conditions.length > 0) {
      sql += ' WHERE ' + conditions.join(' AND ');
    }

    const row = db.query(sql).get(...joinParams, ...whereParams) as { count: number };
    return row.count;
  }

  function getSpaceGraph(
    space: string,
    opts?: { limit?: number; maxLimit?: number }
  ): {
    nodes: { id: string; name: string; tier: Tier; links_to: string[]; linked_by: string[] }[];
    meta: {
      total_nodes: number;
      returned_nodes: number;
      requested_limit: number;
      applied_limit: number;
      max_limit: number;
      truncated: boolean;
    };
  } {
    const spaceRow = db.query('SELECT 1 FROM spaces WHERE name = ?').get(space);
    if (!spaceRow)
      throw new Error(`Space "${space}" does not exist. Create it first with space_create tool.`);

    const requestedLimit = opts?.limit ?? 300;
    const maxLimit = opts?.maxLimit ?? 1000;
    const normalizedRequestedLimit = Math.max(1, Math.trunc(requestedLimit));
    const appliedLimit = Math.min(normalizedRequestedLimit, Math.max(1, Math.trunc(maxLimit)));

    const totalRow = db
      .query(
        'SELECT COUNT(*) as total FROM memories m JOIN spaces s ON s.id = m.space_id WHERE s.name = ? AND m.tier < 4'
      )
      .get(space) as {
      total: number;
    };
    const totalNodes = totalRow.total;

    const rows = db
      .query(
        `SELECT m.id, m.name, m.tier
                 FROM memories m
                 JOIN spaces s ON s.id = m.space_id
                 WHERE s.name = ? AND m.tier < 4
                 ORDER BY m.tier ASC, m.access_count DESC, m.name ASC
                 LIMIT ?`
      )
      .all(space, appliedLimit) as { id: string; name: string; tier: Tier }[];

    const nodeMap = new Map<
      string,
      { id: string; name: string; tier: Tier; links_to: string[]; linked_by: string[] }
    >(
      rows.map(row => [
        row.id,
        { id: row.id, name: row.name, tier: row.tier, links_to: [], linked_by: [] },
      ])
    );

    if (rows.length > 0) {
      const selectedIds = rows.map(row => row.id);
      const placeholders = selectedIds.map(() => '?').join(',');
      const params = [space, space, ...selectedIds, ...selectedIds];

      const linkRows = db
        .query(
          `SELECT l.source_id, l.target_id
                     FROM links l
                     JOIN memories sm ON sm.id = l.source_id
                     JOIN spaces ss ON ss.id = sm.space_id
                     JOIN memories tm ON tm.id = l.target_id
                     JOIN spaces ts ON ts.id = tm.space_id
                     WHERE ss.name = ?
                       AND ts.name = ?
                       AND (l.source_id IN (${placeholders}) OR l.target_id IN (${placeholders}))`
        )
        .all(...params) as { source_id: string; target_id: string }[];

      for (const linkRow of linkRows) {
        const sourceNode = nodeMap.get(linkRow.source_id);
        if (sourceNode) sourceNode.links_to.push(linkRow.target_id);

        const targetNode = nodeMap.get(linkRow.target_id);
        if (targetNode) targetNode.linked_by.push(linkRow.source_id);
      }

      for (const node of nodeMap.values()) {
        node.links_to.sort();
        node.linked_by.sort();
      }
    }

    const nodes = rows.map(row => nodeMap.get(row.id)!);

    return {
      nodes,
      meta: {
        total_nodes: totalNodes,
        returned_nodes: nodes.length,
        requested_limit: normalizedRequestedLimit,
        applied_limit: appliedLimit,
        max_limit: Math.max(1, Math.trunc(maxLimit)),
        truncated: nodes.length < totalNodes,
      },
    };
  }

  return {
    searchMemories,
    searchFallback,
    searchFts5,
    searchLike,
    searchSemantic,
    queryMemories,
    queryMemoriesCount,
    getSpaceGraph,
  };
}
