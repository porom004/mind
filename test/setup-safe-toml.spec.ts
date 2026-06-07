// Tests for the Codex TOML safe-config helpers.
//
// Codex writes its MCP config to `~/.codex/config.toml`, which is TOML, not
// JSON. The setup pipeline must still honor the parse-safely / backup /
// atomic contract that the JSON and JSONC helpers already enforce, and
// `MalformedConfigError.parser` must now include 'toml' so callers can
// branch on it without losing type safety.
//
// These tests pin the contract; production code only lands once they go
// green.
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import { MalformedConfigError, readTomlOrThrow, safeWriteToml } from '../src/setup/safe-config';

let tempHome = '';

beforeEach(() => {
  tempHome = mkdtempSync(join(tmpdir(), 'mind-safe-toml-'));
});

afterEach(() => {
  if (tempHome && existsSync(tempHome)) {
    rmSync(tempHome, { recursive: true, force: true });
  }
});

describe('readTomlOrThrow', () => {
  test('returns empty object for a missing file (caller treats as create)', () => {
    expect(readTomlOrThrow(join(tempHome, 'missing.toml'))).toEqual({});
  });

  test('parses a valid TOML document and exposes nested tables', () => {
    const path = join(tempHome, 'valid.toml');
    writeFileSync(
      path,
      [
        '# top-level comment',
        '[mcp_servers.mind]',
        'command = "/usr/local/bin/mind"',
        'args = ["mcp"]',
        '',
      ].join('\n')
    );
    const parsed = readTomlOrThrow(path) as Record<string, unknown>;
    const mcpServers = parsed.mcp_servers as Record<string, unknown>;
    const mind = mcpServers.mind as Record<string, unknown>;
    expect(mind.command).toBe('/usr/local/bin/mind');
    expect(mind.args).toEqual(['mcp']);
  });

  test('throws MalformedConfigError with parser="toml" on syntactically invalid TOML', () => {
    const path = join(tempHome, 'broken.toml');
    const original = '[mcp_servers.mind]\ncommand = "unterminated string\n';
    writeFileSync(path, original);

    let caught: Error | null = null;
    try {
      readTomlOrThrow(path);
    } catch (err) {
      caught = err as Error;
    }
    expect(caught).not.toBeNull();
    expect(caught).toBeInstanceOf(MalformedConfigError);
    expect((caught as MalformedConfigError).parser).toBe('toml');
    expect(String(caught?.message ?? '')).toMatch(/toml/i);
    // File is byte-for-byte untouched.
    expect(readFileSync(path, 'utf-8')).toBe(original);
  });

  test('throws on empty file (treated as malformed, not as missing)', () => {
    const path = join(tempHome, 'empty.toml');
    writeFileSync(path, '');

    expect(() => readTomlOrThrow(path)).toThrow();
  });
});

describe('MalformedConfigError parser discriminator', () => {
  test('accepts "json" | "jsonc" | "toml" without TypeScript errors', () => {
    // This is a static check: if the union were narrower, this file would
    // fail to typecheck. We exercise each branch to lock the surface.
    for (const parser of ['json', 'jsonc', 'toml'] as const) {
      const err = new MalformedConfigError('/tmp/x.toml', parser, null);
      expect(err.parser).toBe(parser);
      expect(String(err.message)).toContain(parser);
    }
  });
});

describe('safeWriteToml', () => {
  test('creates a new file when none exists (no backup, no throw)', () => {
    const path = join(tempHome, 'new.toml');
    safeWriteToml(path, '[mcp_servers.mind]\ncommand = "/x/mind"\nargs = ["mcp"]\n');
    expect(readFileSync(path, 'utf-8')).toContain('[mcp_servers.mind]');
    // No backup sibling for a previously-missing target.
    const entries = readdirSync(tempHome).filter(n => n.startsWith('new.toml.bak.'));
    expect(entries).toEqual([]);
  });

  test('backs up the existing file before mutating it', () => {
    const path = join(tempHome, 'mutated.toml');
    const original = '[unrelated]\nkey = "preserve me"\n';
    writeFileSync(path, original);

    safeWriteToml(path, `${original}[mcp_servers.mind]\ncommand = "/new/mind"\nargs = ["mcp"]\n`);

    const after = readFileSync(path, 'utf-8');
    expect(after).toContain('[mcp_servers.mind]');
    expect(after).toContain('[unrelated]');
    expect(after).toContain('key = "preserve me"');

    const entries = readdirSync(tempHome).filter(n => n.startsWith('mutated.toml.bak.'));
    expect(entries.length).toBe(1);
    expect(readFileSync(join(tempHome, entries[0] as string), 'utf-8')).toBe(original);
  });

  test('throws (without writing) when the existing file is malformed TOML', () => {
    const path = join(tempHome, 'broken.toml');
    const original = '[mcp_servers.mind]\ncommand = "unterminated string\n';
    writeFileSync(path, original);

    let caught: Error | null = null;
    try {
      safeWriteToml(path, '[mcp_servers.mind]\ncommand = "/x/mind"\n');
    } catch (err) {
      caught = err as Error;
    }
    expect(caught).not.toBeNull();
    expect(caught).toBeInstanceOf(MalformedConfigError);
    expect((caught as MalformedConfigError).parser).toBe('toml');
    // Original bytes unchanged.
    expect(readFileSync(path, 'utf-8')).toBe(original);
    // No backup created (we never reached the write step).
    const entries = readdirSync(tempHome).filter(n => n.startsWith('broken.toml.bak.'));
    expect(entries).toEqual([]);
  });
});
