import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, test } from 'bun:test';

const SPECS_ROOT = join(import.meta.dir, '..', 'specs', 'features');

function readFeature(relativePath: string): string {
  return readFileSync(join(SPECS_ROOT, relativePath), 'utf-8');
}

describe('approved gherkin continuity contract', () => {
  test('product continuity feature exists under include-filtered path with approved tags', () => {
    const featurePath = join(SPECS_ROOT, 'product', 'single-space-session-continuity.feature');

    expect(existsSync(featurePath)).toBe(true);

    const content = readFeature('product/single-space-session-continuity.feature');
    expect(content).toContain('@product_single_space');
    expect(content).toContain('@product_tiering');
    expect(content).toContain('@product_recovery');
    expect(content).toContain('@product_automation');
    expect(content).not.toContain('sessions/');
  });

  test('application migration feature exists under include-filtered path with approved tags', () => {
    const featurePath = join(SPECS_ROOT, 'application', 'single-space-session-migration.feature');

    expect(existsSync(featurePath)).toBe(true);

    const content = readFeature('application/single-space-session-migration.feature');
    expect(content).toContain('@application_migration');
    expect(content).toContain('@application_link_preservation');
    expect(content).toContain('@application_idempotency');
    expect(content).not.toContain('sessions/<repo>');
  });

  test('legacy checkpoint feature wording no longer teaches sessions spaces for new flows', () => {
    const mcpCheckpoint = readFeature('mcp/checkpoint.feature');
    const transformation = readFeature('mcp/checkpoint-session-transformation.feature');

    expect(mcpCheckpoint).not.toContain('sessions/test');
    expect(transformation).not.toContain('sessions/mind');
    expect(transformation).toContain('projects/mind');
    expect(transformation).not.toContain('sessions/<repo>');
  });
});
