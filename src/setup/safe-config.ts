// Safe setup config I/O for mind.
//
// Invariants (mandated by the critical data-loss fix):
//
//   1. Parse failures NEVER become silent empty objects. If a file exists and
//      cannot be parsed, helpers throw a typed error so the calling setup
//      command can abort the run instead of overwriting the file with an
//      empty default and corrupting the user's agent config.
//
//   2. Content-changing writes are preceded by a timestamped backup of the
//      pre-write file. The backup path is deterministic enough for humans to
//      find but unique enough to avoid collisions on repeated runs.
//
//   3. Writes are atomic: payload is staged into a sibling temp file, fsynced,
//      then renamed into place. A failed rename leaves the original file
//      untouched.
//
//   4. Backups are NOT pruned by this module. Pruning is a separate concern
//      and out of scope for the data-loss fix.

import * as fs from 'node:fs';
import * as path from 'node:path';

import {
  applyEdits,
  modify as jsoncModify,
  parse as jsoncParse,
  type FormattingOptions,
  type ParseError,
  type ParseErrorCode,
  type ParseOptions,
} from 'jsonc-parser';

export class SafeConfigError extends Error {
  constructor(
    message: string,
    public readonly filePath: string,
    public readonly cause?: unknown
  ) {
    super(message);
    this.name = 'SafeConfigError';
  }
}

export class MalformedConfigError extends SafeConfigError {
  constructor(
    filePath: string,
    public readonly parser: 'json' | 'jsonc' | 'toml',
    public readonly parserErrors: ReadonlyArray<ParseError> | null,
    cause?: unknown
  ) {
    const detail =
      parserErrors && parserErrors.length > 0
        ? ` (${parserErrors.map(e => printParseError(e)).join('; ')})`
        : '';
    super(
      `Refusing to overwrite ${filePath}: malformed ${parser}${detail}. ` +
        `Run \`mind setup\` only after repairing the file by hand.`,
      filePath,
      cause
    );
    this.name = 'MalformedConfigError';
  }
}

const JSONC_PARSE_OPTIONS: ParseOptions = {
  allowTrailingComma: true,
  disallowComments: false,
};

const JSONC_FORMATTING: FormattingOptions = {
  insertSpaces: true,
  tabSize: 2,
  eol: '\n',
  keepLines: true,
};

// jsonc-parser emits synthetic `ValueExpected` / `CommaExpected` errors while
// it recovers from a trailing comma. Those errors are non-fatal: the parsed
// value is correct. Filter them out so we only surface real structural
// problems.
const RECOVERABLE_JSONC_ERROR_CODES: ReadonlySet<ParseErrorCode> = new Set([
  4 satisfies ParseErrorCode.ValueExpected,
  6 satisfies ParseErrorCode.CommaExpected,
]);

function ensureDir(dirPath: string): void {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

function readFileOrNull(filePath: string): string | null {
  try {
    return fs.readFileSync(filePath, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return null;
    }
    throw err;
  }
}

function printParseError(err: ParseError): string {
  return `offset ${err.offset} (${err.error})`;
}

function filterRecoverableErrors(errors: ReadonlyArray<ParseError>): ParseError[] {
  return errors.filter(e => !RECOVERABLE_JSONC_ERROR_CODES.has(e.error));
}

// ---------------------------------------------------------------------------
// Readers
// ---------------------------------------------------------------------------

/**
 * Reads a strict JSON file as a `Record<string, unknown>`. The file MUST be
 * an object literal (or empty). Arrays, primitives, and parse failures throw.
 *
 * - Missing file => returns `{}` (caller is creating a new file).
 * - Empty file  => throws (an empty file is a parse failure, not a missing one).
 * - Parse error => throws `MalformedConfigError`.
 * - Root is not an object => throws `SafeConfigError`.
 */
export function readJsonOrThrow(filePath: string): Record<string, unknown> {
  const text = readFileOrNull(filePath);
  if (text === null) {
    return {};
  }
  if (text.length === 0) {
    throw new SafeConfigError(
      `Refusing to read ${filePath}: file is empty (treat as malformed).`,
      filePath
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new MalformedConfigError(filePath, 'json', null, err);
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new SafeConfigError(`Refusing to read ${filePath}: root is not a JSON object.`, filePath);
  }
  return parsed as Record<string, unknown>;
}

/**
 * Reads a JSONC file (with comments and trailing commas allowed) as a
 * `Record<string, unknown>`. Same invariants as `readJsonOrThrow` for missing
 * files and root type. Parse failures throw `MalformedConfigError`.
 */
export function readJsoncOrThrow(filePath: string): Record<string, unknown> {
  const text = readFileOrNull(filePath);
  if (text === null) {
    return {};
  }
  if (text.length === 0) {
    throw new SafeConfigError(
      `Refusing to read ${filePath}: file is empty (treat as malformed).`,
      filePath
    );
  }
  const errors: ParseError[] = [];
  const parsed = jsoncParse(text, errors, JSONC_PARSE_OPTIONS);
  const realErrors = filterRecoverableErrors(errors);
  if (realErrors.length > 0) {
    throw new MalformedConfigError(filePath, 'jsonc', realErrors);
  }
  if (parsed === undefined || parsed === null) {
    throw new SafeConfigError(
      `Refusing to read ${filePath}: file is empty or comments-only.`,
      filePath
    );
  }
  if (typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new SafeConfigError(`Refusing to read ${filePath}: root is not a JSON object.`, filePath);
  }
  return parsed as Record<string, unknown>;
}

/**
 * Returns the raw text of a JSONC file so callers can hand it to
 * jsonc-parser editing helpers that preserve comments and formatting. Missing
 * file => empty string.
 */
export function readJsoncFileForEdit(filePath: string): string {
  return readFileOrNull(filePath) ?? '';
}

// ---------------------------------------------------------------------------
// TOML (Codex config.toml) — added in the Codex safe-write regression fix.
//
// We rely on `Bun.TOML.parse`, which is built into Bun. A feature-detect
// guard throws a clear `SafeConfigError` if the runtime ever drops the
// built-in (so callers abort rather than silently writing garbage). No TOML
// npm dependency is introduced.
// ---------------------------------------------------------------------------

type BunWithToml = {
  TOML?: { parse?: (text: string) => unknown };
};

function parseToml(text: string): unknown {
  const toml = (Bun as unknown as BunWithToml).TOML;
  if (!toml || typeof toml.parse !== 'function') {
    throw new SafeConfigError(
      'TOML parsing requires Bun.TOML.parse, which is not available in this runtime.',
      ''
    );
  }
  try {
    return toml.parse(text);
  } catch (err) {
    throw new MalformedConfigError('(inline)', 'toml', null, err);
  }
}

/**
 * Reads a TOML file as a `Record<string, unknown>`. The file MUST be a TOML
 * document whose root is a table. Missing file => `{}` (caller creates a new
 * file). Parse failures throw `MalformedConfigError` with `parser === 'toml'`.
 */
export function readTomlOrThrow(filePath: string): Record<string, unknown> {
  const text = readFileOrNull(filePath);
  if (text === null) {
    return {};
  }
  if (text.length === 0) {
    throw new SafeConfigError(
      `Refusing to read ${filePath}: file is empty (treat as malformed).`,
      filePath
    );
  }
  let parsed: unknown;
  try {
    parsed = parseToml(text);
  } catch (err) {
    if (err instanceof MalformedConfigError && err.filePath === '(inline)') {
      throw new MalformedConfigError(filePath, 'toml', null, err.cause);
    }
    throw err;
  }
  if (parsed === null || parsed === undefined) {
    throw new SafeConfigError(`Refusing to read ${filePath}: TOML root is empty.`, filePath);
  }
  if (typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new SafeConfigError(`Refusing to read ${filePath}: TOML root is not a table.`, filePath);
  }
  return parsed as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Backups
// ---------------------------------------------------------------------------

/**
 * If `filePath` exists, creates a timestamped sibling backup with the same
 * bytes and returns the backup path. Returns null if the file does not
 * exist. Backup files are intentionally NOT pruned here.
 */
export function backupIfExists(filePath: string): string | null {
  if (!fs.existsSync(filePath)) {
    return null;
  }
  const stamp = formatTimestamp(new Date());
  const backupPath = `${filePath}.bak.${stamp}`;
  fs.copyFileSync(filePath, backupPath);
  return backupPath;
}

function formatTimestamp(date: Date): string {
  // YYYYMMDDTHHMMSSmmm (filesystem-safe, sortable, no spaces)
  const pad = (n: number, w = 2): string => String(n).padStart(w, '0');
  return (
    `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}` +
    `T${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}` +
    `${pad(date.getUTCMilliseconds(), 3)}Z`
  );
}

// ---------------------------------------------------------------------------
// Writers
// ---------------------------------------------------------------------------

/**
 * Atomic text write. Stages content into `<filePath>.<rand>.tmp` in the
 * target's parent directory, fsyncs, then renames onto the target. A failed
 * rename leaves the target untouched.
 */
export function atomicWriteText(filePath: string, content: string): void {
  ensureDir(path.dirname(filePath));
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.${Math.random()
    .toString(36)
    .slice(2, 10)}.tmp`;
  let fd: number | null = null;
  try {
    fd = fs.openSync(tempPath, 'w', 0o644);
    fs.writeSync(fd, content);
    fs.fsyncSync(fd);
  } finally {
    if (fd !== null) {
      fs.closeSync(fd);
    }
  }
  try {
    fs.renameSync(tempPath, filePath);
  } catch (err) {
    // Best-effort cleanup; never throw a cleanup error past the original cause.
    try {
      fs.unlinkSync(tempPath);
    } catch {
      // ignore
    }
    throw err;
  }
}

/**
 * Safe JSON write: backup the existing file (if any) then write a new JSON
 * document atomically. `value` is stringified with 2-space indent to match
 * the existing mind setup style.
 */
export function safeWriteJson(filePath: string, value: Record<string, unknown>): void {
  backupIfExists(filePath);
  atomicWriteText(filePath, JSON.stringify(value, null, 2) + '\n');
}

/**
 * Safe JSONC write with comment-preserving edit. The `updater` receives the
 * current parsed object and returns the desired new object. The result is
 * applied through `jsonc-parser.modify`, which keeps comments, indentation,
 * and original key ordering wherever possible. The existing file is backed
 * up first; if the existing file is malformed the helper throws and the file
 * remains byte-for-byte unchanged.
 */
export function safeWriteJsonc(
  filePath: string,
  updater: (current: Record<string, unknown>) => Record<string, unknown>
): void {
  const existing = readFileOrNull(filePath);
  if (existing === null) {
    // Brand-new file: no backup, no parse, just write.
    const next = updater({});
    atomicWriteText(filePath, JSON.stringify(next, null, 2) + '\n');
    return;
  }
  if (existing.length === 0) {
    throw new SafeConfigError(
      `Refusing to overwrite ${filePath}: file is empty (treat as malformed).`,
      filePath
    );
  }
  const errors: ParseError[] = [];
  const parsed = jsoncParse(existing, errors, JSONC_PARSE_OPTIONS);
  const realErrors = filterRecoverableErrors(errors);
  if (realErrors.length > 0) {
    throw new MalformedConfigError(filePath, 'jsonc', realErrors);
  }
  const current =
    parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  // Snapshot the key set and values BEFORE the updater runs. The updater
  // typically mutates `current` in place, so comparing key sets or values
  // after the call would be a no-op (`current === next`).
  const preUpdateKeys = Object.keys(current);
  const currentSnapshot: Record<string, unknown> = { ...current };
  const next = updater(current);
  const postUpdateKeys = Object.keys(next);

  // If the updater added or removed top-level keys, fall back to a clean
  // rewrite (jsonc-parser cannot preserve the document structure across key
  // set changes). Otherwise try to preserve comments by applying edits in
  // place.
  const keySetChanged =
    preUpdateKeys.length !== postUpdateKeys.length ||
    preUpdateKeys.some(k => !Object.prototype.hasOwnProperty.call(next, k));
  const edits = keySetChanged ? null : computeJsoncEdits(existing, currentSnapshot, next);
  let nextText: string;
  if (edits === null) {
    nextText = JSON.stringify(next, null, 2) + '\n';
  } else {
    nextText = applyEdits(existing, edits);
    if (!nextText.endsWith('\n')) {
      nextText += '\n';
    }
  }

  backupIfExists(filePath);
  atomicWriteText(filePath, nextText);
}

/**
 * Safe TOML write: parse the existing file (if any) to abort on malformed
 * input, then back up the pre-write bytes and write `nextText` atomically.
 * No JSON/JSONC reformatting is attempted — the caller owns the textual
 * diff because TOML preserves comments and table ordering and the caller
 * may have done a surgical text edit.
 *
 * - Missing file => no backup, no parse, just write.
 * - Empty file  => throw (treat as malformed, do not overwrite).
 * - Malformed   => throw `MalformedConfigError` with `parser === 'toml'`,
 *                  leave the file byte-for-byte unchanged, no backup.
 */
export function safeWriteToml(filePath: string, nextText: string): void {
  const existing = readFileOrNull(filePath);
  if (existing === null) {
    atomicWriteText(filePath, nextText);
    return;
  }
  if (existing.length === 0) {
    throw new SafeConfigError(
      `Refusing to overwrite ${filePath}: file is empty (treat as malformed).`,
      filePath
    );
  }
  // Validate the existing file by parsing it. If it's malformed, throw
  // BEFORE creating a backup, so a bad input never produces an orphan .bak.
  try {
    parseToml(existing);
  } catch (err) {
    if (err instanceof MalformedConfigError && err.filePath === '(inline)') {
      throw new MalformedConfigError(filePath, 'toml', null, err.cause);
    }
    throw err;
  }
  backupIfExists(filePath);
  atomicWriteText(filePath, nextText);
}

/**
 * Computes jsonc-parser edits that transform `current` into `next` while
 * preserving the formatting of unchanged keys. Returns `null` when a clean
 * rewrite is safer (e.g. keys were added or removed, or jsonc-parser cannot
 * reliably express the change).
 */
function computeJsoncEdits(
  sourceText: string,
  current: Record<string, unknown>,
  next: Record<string, unknown>
): ReturnType<typeof jsoncModify> | null {
  const currentKeys = Object.keys(current);
  const nextKeys = Object.keys(next);
  if (currentKeys.length !== nextKeys.length) {
    return null;
  }
  for (const key of currentKeys) {
    if (!Object.prototype.hasOwnProperty.call(next, key)) {
      return null;
    }
  }

  const edits: ReturnType<typeof jsoncModify> = [];
  for (const key of nextKeys) {
    const before = current[key];
    const after = next[key];
    if (deepEqual(before, after)) {
      continue;
    }
    const segment = jsoncModify(sourceText, [key], after, {
      formattingOptions: JSONC_FORMATTING,
    });
    edits.push(...segment);
  }
  return edits;
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null) return false;
  if (typeof a !== typeof b) return false;
  if (typeof a !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (!deepEqual(a[i], b[i])) return false;
    }
    return true;
  }
  const aKeys = Object.keys(a as Record<string, unknown>);
  const bKeys = Object.keys(b as Record<string, unknown>);
  if (aKeys.length !== bKeys.length) return false;
  for (const key of aKeys) {
    if (!deepEqual((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key])) {
      return false;
    }
  }
  return true;
}
