// Test file rewrite - fix the 5 issues
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import {
  atomicWriteText,
  backupIfExists,
  readJsoncFileForEdit,
  readJsoncOrThrow,
  readJsonOrThrow,
  safeWriteJson,
  safeWriteJsonc,
} from '../src/setup/safe-config';

let tempHome = '';

beforeEach(() => {
  tempHome = mkdtempSync(join(tmpdir(), 'mind-safe-config-'));
});

afterEach(() => {
  if (tempHome && existsSync(tempHome)) {
    rmSync(tempHome, { recursive: true, force: true });
  }
});

describe('readJsonOrThrow', () => {
  test('returns empty object for missing file', () => {
    expect(readJsonOrThrow(join(tempHome, 'missing.json'))).toEqual({});
  });

  test('returns parsed object for valid JSON file', () => {
    const path = join(tempHome, 'valid.json');
    writeFileSync(path, '{"a": 1, "b": "x"}');
    expect(readJsonOrThrow(path)).toEqual({ a: 1, b: 'x' });
  });

  test('aborts with throw on malformed JSON, original bytes untouched', () => {
    const path = join(tempHome, 'broken.json');
    const original = '{ "this is": not valid json,';
    writeFileSync(path, original);

    let caught: Error | null = null;
    try {
      readJsonOrThrow(path);
    } catch (err) {
      caught = err as Error;
    }
    expect(caught).not.toBeNull();
    expect(String(caught?.message ?? '')).toMatch(/malformed|parse|json/i);
    expect(readFileSync(path, 'utf-8')).toBe(original);
  });

  test('throws on file that is a JSON array (root not object)', () => {
    const path = join(tempHome, 'array.json');
    writeFileSync(path, '[1, 2, 3]');
    expect(() => readJsonOrThrow(path)).toThrow(/object|root/i);
  });

  test('throws on file that is a JSON primitive (root not object)', () => {
    const path = join(tempHome, 'primitive.json');
    writeFileSync(path, '42');
    expect(() => readJsonOrThrow(path)).toThrow(/object|root/i);
  });

  test('throws on empty file', () => {
    const path = join(tempHome, 'empty.json');
    writeFileSync(path, '');
    expect(() => readJsonOrThrow(path)).toThrow(/malformed|parse|empty|json/i);
  });
});

describe('readJsoncOrThrow', () => {
  test('returns empty object for missing file', () => {
    expect(readJsoncOrThrow(join(tempHome, 'missing.jsonc'))).toEqual({});
  });

  test('parses JSONC with line and block comments', () => {
    const path = join(tempHome, 'comments.jsonc');
    writeFileSync(
      path,
      `{
      // top-level comment
      "name": "demo", /* inline */
      "list": [1, 2, /* mid */ 3]
    }`
    );
    const parsed = readJsoncOrThrow(path) as Record<string, unknown>;
    expect(parsed.name).toBe('demo');
    expect(parsed.list).toEqual([1, 2, 3]);
  });

  test('parses JSONC with trailing commas', () => {
    const path = join(tempHome, 'trailing.jsonc');
    writeFileSync(path, '{ "a": 1, "b": [1, 2, 3,] }');
    const parsed = readJsoncOrThrow(path) as Record<string, unknown>;
    expect(parsed.a).toBe(1);
    expect(parsed.b).toEqual([1, 2, 3]);
  });

  test('throws on syntactically invalid JSONC and leaves file unchanged', () => {
    const path = join(tempHome, 'broken.jsonc');
    const original = '{ "missing": ,';
    writeFileSync(path, original);
    expect(() => readJsoncOrThrow(path)).toThrow();
    expect(readFileSync(path, 'utf-8')).toBe(original);
  });
});

describe('readJsoncFileForEdit', () => {
  test('returns the raw text for jsonc-parser based editing', () => {
    const path = join(tempHome, 'edit.jsonc');
    const text = '// header comment\n{"a": 1}\n';
    writeFileSync(path, text);
    expect(readJsoncFileForEdit(path)).toBe(text);
  });

  test('returns empty string for missing file (caller treats as create)', () => {
    expect(readJsoncFileForEdit(join(tempHome, 'missing.jsonc'))).toBe('');
  });
});

describe('backupIfExists', () => {
  test('returns null when target does not exist', () => {
    expect(backupIfExists(join(tempHome, 'absent.json'))).toBeNull();
  });

  test('creates timestamped sibling backup with exact pre-setup content', () => {
    const path = join(tempHome, 'existing.json');
    const original = '{\n  "preserve": "me"\n}\n';
    writeFileSync(path, original);

    const backupPath = backupIfExists(path);
    expect(backupPath).not.toBeNull();
    expect(existsSync(backupPath as string)).toBe(true);
    expect(readFileSync(backupPath as string, 'utf-8')).toBe(original);
    expect(backupPath as string).toMatch(/\.json\.bak\./);
  });

  test('two consecutive backups do not collide', () => {
    const path = join(tempHome, 'collision.json');
    writeFileSync(path, 'first');
    const a = backupIfExists(path);
    // ensure the timestamp is different even within the same millisecond
    const start = Date.now();
    while (Date.now() - start < 5) {
      /* spin */
    }
    writeFileSync(path, 'second');
    const b = backupIfExists(path);
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    expect(a).not.toBe(b);
    expect(readFileSync(a as string, 'utf-8')).toBe('first');
    expect(readFileSync(b as string, 'utf-8')).toBe('second');
  });
});

describe('atomicWriteText', () => {
  test('writes the file atomically and creates missing parent dirs', () => {
    const path = join(tempHome, 'nested', 'deep', 'file.txt');
    atomicWriteText(path, 'hello world');
    expect(readFileSync(path, 'utf-8')).toBe('hello world');
  });

  test('leaves no partial write when the target parent cannot host a rename', () => {
    // Construct a real failure: a file is in the way of a directory
    // component, so creating the sibling temp file or the final rename
    // cannot complete. The target file must remain absent and the
    // blocker must be untouched.
    const blocker = join(tempHome, 'blocker');
    writeFileSync(blocker, 'I am a regular file');
    const path = join(blocker, 'cannot', 'create', 'this.txt');

    let caught: Error | null = null;
    try {
      atomicWriteText(path, 'should not be visible');
    } catch (err) {
      caught = err as Error;
    }
    expect(caught).not.toBeNull();
    // The target path must NOT exist.
    expect(existsSync(path)).toBe(false);
    // The blocker file is untouched.
    expect(readFileSync(blocker, 'utf-8')).toBe('I am a regular file');
  });

  test('throws (without writing target) when target parent is an existing file', () => {
    // Same as above but at a shallower level: the immediate parent of the
    // target is a regular file. Atomic write must fail and not produce a
    // half-written target.
    const blocker = join(tempHome, 'parent-is-a-file');
    writeFileSync(blocker, 'parent file, not a directory');
    const path = join(blocker, 'child.txt');

    let caught: Error | null = null;
    try {
      atomicWriteText(path, 'partial content');
    } catch (err) {
      caught = err as Error;
    }
    expect(caught).not.toBeNull();
    expect(existsSync(path)).toBe(false);
    expect(readFileSync(blocker, 'utf-8')).toBe('parent file, not a directory');
  });

  test('does not leave orphan temp files on success', () => {
    const path = join(tempHome, 'no-orphan.txt');
    atomicWriteText(path, 'clean');
    const siblings = readdirSync(tempHome);
    expect(siblings.filter(n => n.endsWith('.tmp'))).toEqual([]);
    expect(siblings).toContain('no-orphan.txt');
  });
});

describe('safeWriteJson', () => {
  test('creates a new file when none exists (no backup, no throw)', () => {
    const path = join(tempHome, 'new.json');
    safeWriteJson(path, { hello: 'world' });
    expect(JSON.parse(readFileSync(path, 'utf-8'))).toEqual({ hello: 'world' });
    // No backup sibling for a previously-missing target.
    const entries = readdirSync(tempHome).filter(n => n.startsWith('new.json.bak.'));
    expect(entries).toEqual([]);
  });

  test('backs up an existing valid file before mutating it', () => {
    const path = join(tempHome, 'mutated.json');
    const original = { original: true };
    writeFileSync(path, JSON.stringify(original, null, 2));

    safeWriteJson(path, { replaced: true });

    const main = JSON.parse(readFileSync(path, 'utf-8')) as Record<string, unknown>;
    expect(main.replaced).toBe(true);

    const entries = readdirSync(tempHome).filter(n => n.startsWith('mutated.json.bak.'));
    expect(entries.length).toBe(1);
    const backupContent = JSON.parse(
      readFileSync(join(tempHome, entries[0] as string), 'utf-8')
    ) as Record<string, unknown>;
    expect(backupContent).toEqual(original);
  });

  test('preserves semantic caller-provided keys verbatim (caller owns deep-merge)', () => {
    const path = join(tempHome, 'preserve.json');
    const original = { theme: 'dark', custom: { keep: true } };
    writeFileSync(path, JSON.stringify(original));

    safeWriteJson(path, { theme: 'light' });

    const next = JSON.parse(readFileSync(path, 'utf-8')) as Record<string, unknown>;
    expect(next.theme).toBe('light');
    expect(Object.keys(next).sort()).toEqual(['theme']);
  });
});

describe('safeWriteJsonc', () => {
  test('creates a new file when none exists', () => {
    const path = join(tempHome, 'fresh.jsonc');
    safeWriteJsonc(path, current => {
      (current as Record<string, unknown>).hello = 'world';
      return current;
    });
    const parsed = readJsoncOrThrow(path) as Record<string, unknown>;
    expect(parsed.hello).toBe('world');
  });

  test('preserves comments when modifying an existing JSONC key', () => {
    const path = join(tempHome, 'preserve.jsonc');
    const original = [
      '// top-level note',
      '{',
      '  "theme": "dark", // keep me',
      '  "custom": { "keep": true }',
      '}',
      '',
    ].join('\n');
    writeFileSync(path, original);

    safeWriteJsonc(path, current => {
      const obj = current as Record<string, unknown>;
      obj.theme = 'light';
      return obj;
    });

    const after = readFileSync(path, 'utf-8');
    // jsonc-parser preserves comments and unrelated keys.
    expect(after).toContain('// top-level note');
    expect(after).toContain('// keep me');
    expect(after).toContain('"custom"');

    // The modified value is correct and the file is still parseable JSONC.
    const parsed = readJsoncOrThrow(path) as Record<string, unknown>;
    expect(parsed.theme).toBe('light');
    expect(parsed.custom).toEqual({ keep: true });
  });

  test('cleanly rewrites when JSONC update adds or removes a top-level key', () => {
    // jsonc-parser cannot preserve the document structure when the key set
    // changes. The helper must fall back to a clean rewrite that still
    // contains the new key. Comments may be lost in this case; the
    // guarantee is no data loss, not byte-stable formatting.
    const path = join(tempHome, 'add-key.jsonc');
    const original = ['// top-level note', '{', '  "theme": "dark"', '}', ''].join('\n');
    writeFileSync(path, original);

    safeWriteJsonc(path, current => {
      const obj = current as Record<string, unknown>;
      obj.mcp = { mind: { type: 'local' } };
      return obj;
    });

    const parsed = readJsoncOrThrow(path) as Record<string, unknown>;
    expect(parsed.theme).toBe('dark');
    expect((parsed.mcp as Record<string, unknown>).mind).toEqual({ type: 'local' });

    // Backup still exists with the pre-write content.
    const entries = readdirSync(tempHome).filter(n => n.startsWith('add-key.jsonc.bak.'));
    expect(entries.length).toBe(1);
    expect(readFileSync(join(tempHome, entries[0] as string), 'utf-8')).toBe(original);
  });

  test('backs up an existing file before mutating', () => {
    const path = join(tempHome, 'edit.jsonc');
    const original = '{\n  "a": 1\n}\n';
    writeFileSync(path, original);

    safeWriteJsonc(path, current => {
      (current as Record<string, unknown>).b = 2;
      return current;
    });

    const entries = readdirSync(tempHome).filter(n => n.startsWith('edit.jsonc.bak.'));
    expect(entries.length).toBe(1);
    expect(readFileSync(join(tempHome, entries[0] as string), 'utf-8')).toBe(original);
  });

  test('throws (without writing) when existing file is malformed JSONC', () => {
    const path = join(tempHome, 'broken.jsonc');
    const original = '{ "missing": ,';
    writeFileSync(path, original);

    let caught: Error | null = null;
    try {
      safeWriteJsonc(path, current => current);
    } catch (err) {
      caught = err as Error;
    }
    expect(caught).not.toBeNull();
    expect(readFileSync(path, 'utf-8')).toBe(original);
    // No backup was created (we never reached the write step).
    const entries = readdirSync(tempHome).filter(n => n.startsWith('broken.jsonc.bak.'));
    expect(entries).toEqual([]);
  });
});
