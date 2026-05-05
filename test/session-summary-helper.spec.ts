import { describe, expect, test } from 'bun:test';

import {
  buildOfficialSessionSummaryContent,
  isSessionLikeMemory,
  OFFICIAL_SESSION_SUMMARY_SCHEMA,
} from '../src/helpers/session-summary';

describe('session summary helpers', () => {
  test('buildOfficialSessionSummaryContent preserves checkpoint fields and adds official metadata', () => {
    const content = JSON.parse(
      buildOfficialSessionSummaryContent({
        writer: 'checkpoint_done',
        base: {
          goal: 'Ship feature',
          pending: 'Monitor rollout',
          notes: 'watch metrics',
          createdAt: '2026-04-24 10:00:00',
          updatedAt: '2026-04-24 10:30:00',
        },
        whatWasDone: 'Feature shipped',
        completedAt: '2026-04-24 11:00:00',
        originalCheckpoint: 'checkpoint-1',
        provenance: {
          checkpoint: {
            space: 'projects/mind',
            name: 'checkpoint-1',
          },
        },
      })
    );

    expect(content.goal).toBe('Ship feature');
    expect(content.pending).toBe('Monitor rollout');
    expect(content.notes).toBe('watch metrics');
    expect(content.whatWasDone).toBe('Feature shipped');
    expect(content.originalCheckpoint).toBe('checkpoint-1');
    expect(content.sessionSummary.schema).toBe(OFFICIAL_SESSION_SUMMARY_SCHEMA);
    expect(content.sessionSummary.writer.id).toBe('checkpoint_done');
    expect(content.sessionSummary.provenance.checkpoint.space).toBe('projects/mind');
  });

  test('isSessionLikeMemory tolerates imperfect tags but excludes checkpoints', () => {
    expect(
      isSessionLikeMemory({
        name: 'session-2026-04-24T11-00-00Z',
        tags: ['cat:discovery'],
      })
    ).toBe(true);

    expect(
      isSessionLikeMemory({
        name: 'checkpoint-2026-04-24T11-00-00Z',
        tags: ['checkpoint', 'active'],
        content: JSON.stringify({
          sessionSummary: {
            schema: OFFICIAL_SESSION_SUMMARY_SCHEMA,
          },
        }),
      })
    ).toBe(false);
  });
});
