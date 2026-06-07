import { describe, expect, test } from 'bun:test';

// Re-export types to make tests self-contained
import type { TierChange, HotMemorySummary } from '../src/types';

describe('Phase 1.1 — Type definitions', () => {
  describe('TierChange interface', () => {
    test('should have correct shape: from Tier, to Tier, reason', () => {
      const change: TierChange = {
        from: 2,
        to: 1,
        reason: 'promote',
      };
      expect(change.from).toBe(2);
      expect(change.to).toBe(1);
      expect(change.reason).toBe('promote');
    });

    test('should accept all reason variants', () => {
      const promote: TierChange = { from: 2, to: 1, reason: 'promote' };
      const demote: TierChange = { from: 1, to: 2, reason: 'demote' };
      const auto: TierChange = { from: 3, to: 2, reason: 'auto_promote' };

      expect(promote.reason).toBe('promote');
      expect(demote.reason).toBe('demote');
      expect(auto.reason).toBe('auto_promote');
    });

    test('should allow all tier values 1-3 for from/to', () => {
      const t1to3: TierChange = { from: 1, to: 3, reason: 'demote' };
      const t3to1: TierChange = { from: 3, to: 1, reason: 'promote' };
      expect(t1to3.from).toBe(1);
      expect(t3to1.to).toBe(1);
    });
  });

  describe('HotMemorySummary type', () => {
    test('should have required fields: id, name, tier, tags, pinned, updated_at', () => {
      const summary: HotMemorySummary = {
        id: 'uuid-test-1',
        name: 'test-memory',
        tier: 1,
        tags: ['project', 'important'],
        pinned: false,
        updated_at: '2026-03-21 10:00:00',
      };
      expect(summary.id).toBe('uuid-test-1');
      expect(summary.name).toBe('test-memory');
      expect(summary.tier).toBe(1);
      expect(summary.tags).toEqual(['project', 'important']);
      expect(summary.pinned).toBe(false);
      expect(summary.updated_at).toBe('2026-03-21 10:00:00');
    });

    test('should accept tier 2 as valid HotMemorySummary tier', () => {
      const warm: HotMemorySummary = {
        id: 'uuid-test-2',
        name: 'warm-memory',
        tier: 2,
        tags: [],
        pinned: true,
        updated_at: '2026-03-21 11:00:00',
      };
      expect(warm.tier).toBe(2);
    });

    test('should accept empty tags array', () => {
      const noTags: HotMemorySummary = {
        id: 'uuid-test-3',
        name: 'no-tags',
        tier: 1,
        tags: [],
        pinned: false,
        updated_at: '2026-03-21 12:00:00',
      };
      expect(noTags.tags).toEqual([]);
    });
  });
});
