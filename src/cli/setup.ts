import { spawn, spawnSync } from 'child_process';
import * as fs from 'fs';
import { homedir } from 'os';
import * as path from 'path';

import { DEFAULT_PORT } from '../config';
import { getAgentConfig } from '../setup/agent-config';
import { ensureMindManagementSkill } from '../setup/skill-installation';
export { buildOpenCodeAutomationPlugin } from '../setup/opencode-automation-plugin';
export { getAgentCapabilities, getAgentCapabilityMatrix } from './capabilities';

import {
  type CapabilityMap,
  type SupportedAgent,
  formatCapabilityBadge,
  getAgentCapabilityMatrix,
} from './capabilities';
import { renderMemoryProtocol } from './memory-protocol';

const DEFAULT_MCP_PORT = 7438;

const OPENCODE_MEMORY_PROTOCOL_FILENAME = 'mind-memory-protocol.md';

const OPENCODE_AUTOMATION_PLUGIN_FILENAME = 'mind-automation.js';

const CLAUDE_MEMORY_PROTOCOL_FILENAME = 'mind-memory-protocol.md';

const CLAUDE_MANAGED_BLOCK_START = '<!-- mind managed protocol start -->';
const CLAUDE_MANAGED_BLOCK_END = '<!-- mind managed protocol end -->';

const CLAUDE_HOOK_SCRIPT_NAME = 'mind-session-summary.sh';
const CLAUDE_HOOKS_OPT_IN_ENV = 'MIND_SETUP_CLAUDE_ENABLE_HOOKS';

const CURSOR_HOOK_SCRIPT_NAME = 'mind-session-continuity.sh';
const CURSOR_HOOK_EVENTS = ['sessionStart', 'preCompact', 'stop'] as const;

const LEGACY_PROTOCOL_FILENAMES = [
  'mind-memory-protocol-opencode.md',
  'mind-memory-protocol-claude.md',
  'mind-memory-protocol-claude-code.md',
  'mind-memory-protocol-codex.md',
  'mind-memory-protocol.claude.md',
  'mind-memory-protocol.codex.md',
];

function getHomeDir(): string {
  return process.env.HOME ?? homedir();
}

function ensureDir(dirPath: string): void {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

function getMindScriptPath(): string {
  try {
    const result = spawnSync('command', ['-v', 'mind'], { encoding: 'utf-8', shell: false });
    if (result.status === 0 && result.stdout.trim()) {
      return result.stdout.trim();
    }
  } catch {
    // Fall through to absolute path detection
  }

  // From src/cli/, go up 2 levels to repo root, then append 'mind' script name
  const script = path.resolve(__dirname, '..', '..', 'mind');
  if (fs.existsSync(script)) {
    return script;
  }
  return 'mind';
}

export function tryClaudeMcpAdd(mindPath: string): { ok: boolean; reason?: string } {
  // Check if claude CLI is available
  try {
    const check = spawnSync('command', ['-v', 'claude'], { encoding: 'utf-8', shell: false });
    if (check.status !== 0) {
      return { ok: false, reason: 'claude CLI not found in PATH' };
    }
  } catch {
    return { ok: false, reason: 'claude CLI not found in PATH' };
  }

  // Try claude mcp add
  try {
    const result = spawnSync(
      'claude',
      ['mcp', 'add', '--transport', 'stdio', '--scope', 'user', 'mind', '--', mindPath, 'mcp'],
      { encoding: 'utf-8', shell: false, stdio: 'pipe' }
    );

    if (result.status === 0) {
      return { ok: true };
    } else {
      return { ok: false, reason: result.stderr?.trim() || `exit code ${result.status}` };
    }
  } catch (err) {
    return { ok: false, reason: String(err) };
  }
}

function getMindEntryPath(): string {
  return path.resolve(__dirname, '..', 'mind.ts');
}

function getPidDir(): string {
  return path.join(homedir(), '.mind');
}

function getPidPath(name: 'mcp' | 'serve'): string {
  return path.join(getPidDir(), `${name}.pid`);
}

function writePid(name: 'mcp' | 'serve', pid: number): void {
  ensureDir(getPidDir());
  fs.writeFileSync(getPidPath(name), String(pid));
}

function readPid(name: 'mcp' | 'serve'): number | null {
  const pidPath = getPidPath(name);
  if (!fs.existsSync(pidPath)) return null;
  const pid = Number(fs.readFileSync(pidPath, 'utf-8').trim());
  return Number.isFinite(pid) ? pid : null;
}

function clearPid(name: 'mcp' | 'serve'): void {
  const pidPath = getPidPath(name);
  if (fs.existsSync(pidPath)) {
    fs.unlinkSync(pidPath);
  }
}

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readJson(filePath: string): Record<string, unknown> {
  if (!fs.existsSync(filePath)) return {};
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function writeJson(filePath: string, value: Record<string, unknown>): void {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2));
}

function readText(filePath: string): string {
  if (!fs.existsSync(filePath)) return '';
  return fs.readFileSync(filePath, 'utf-8');
}

function writeText(filePath: string, content: string): void {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, content);
}

function deepMerge(
  base: Record<string, unknown>,
  patch: Record<string, unknown>
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(patch)) {
    const existing = out[k];
    if (
      existing &&
      typeof existing === 'object' &&
      !Array.isArray(existing) &&
      v &&
      typeof v === 'object' &&
      !Array.isArray(v)
    ) {
      out[k] = deepMerge(existing as Record<string, unknown>, v as Record<string, unknown>);
    } else {
      out[k] = v;
    }
  }
  return out;
}

function ensureOpenCodeInstructionPath(): string {
  const instructionsDir = path.join(getHomeDir(), '.config', 'opencode', 'instructions');
  const instructionPath = path.join(instructionsDir, OPENCODE_MEMORY_PROTOCOL_FILENAME);
  ensureDir(instructionsDir);
  removeLegacyProtocolFiles(instructionsDir);
  writeText(instructionPath, renderMemoryProtocol('opencode'));
  return instructionPath;
}

function isLegacyProtocolPath(entry: unknown): boolean {
  if (typeof entry !== 'string') {
    return false;
  }

  return LEGACY_PROTOCOL_FILENAMES.includes(path.basename(entry));
}

function dedupeStringEntries(values: unknown[]): string[] {
  const deduped: string[] = [];
  const seen = new Set<string>();

  for (const value of values) {
    if (typeof value !== 'string') {
      continue;
    }

    if (!seen.has(value)) {
      deduped.push(value);
      seen.add(value);
    }
  }

  return deduped;
}

function removeLegacyProtocolFiles(baseDir: string): void {
  for (const filename of LEGACY_PROTOCOL_FILENAMES) {
    const candidate = path.join(baseDir, filename);
    if (fs.existsSync(candidate)) {
      fs.unlinkSync(candidate);
    }
  }
}

function placeInstructionFirst(
  config: Record<string, unknown>,
  instructionPath: string
): Record<string, unknown> {
  const existingInstructions = Array.isArray(config.instructions) ? config.instructions : [];
  const sanitized = dedupeStringEntries(existingInstructions).filter(
    entry => entry !== instructionPath && !isLegacyProtocolPath(entry)
  );
  return {
    ...config,
    instructions: [instructionPath, ...sanitized],
  };
}

// buildOpenCodeAutomationPlugin is now imported from ../setup/opencode-automation-plugin

function ensureOpenCodeAutomationPlugin(mindPath: string): string {
  const pluginsDir = path.join(getHomeDir(), '.config', 'opencode', 'plugins');
  const pluginPath = path.join(pluginsDir, OPENCODE_AUTOMATION_PLUGIN_FILENAME);
  ensureDir(pluginsDir);
  // Import the extracted function
  const { buildOpenCodeAutomationPlugin } = require('../setup/opencode-automation-plugin');
  writeText(pluginPath, buildOpenCodeAutomationPlugin(mindPath));
  return pluginPath;
}

function ensureClaudeInstructionPath(): string {
  const instructionsDir = path.join(getHomeDir(), '.claude', 'instructions');
  const instructionPath = path.join(instructionsDir, CLAUDE_MEMORY_PROTOCOL_FILENAME);
  ensureDir(instructionsDir);
  removeLegacyProtocolFiles(instructionsDir);
  writeText(instructionPath, renderMemoryProtocol('claude-code'));
  return instructionPath;
}

function upsertManagedBlock(content: string, block: string): string {
  const escapedStart = CLAUDE_MANAGED_BLOCK_START.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const escapedEnd = CLAUDE_MANAGED_BLOCK_END.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`${escapedStart}[\\s\\S]*?${escapedEnd}`, 'g');
  const stripped = content
    .replace(pattern, '')
    .replace(/\n{3,}/g, '\n\n')
    .trimEnd();

  if (stripped.length === 0) {
    return `${block}\n`;
  }

  return `${stripped}\n\n${block}\n`;
}

function ensureClaudeManagedInstructions(instructionPath: string): void {
  const claudeDir = path.join(getHomeDir(), '.claude');
  const claudeMdPath = path.join(claudeDir, 'CLAUDE.md');

  ensureDir(claudeDir);
  const current = readText(claudeMdPath);

  const managedBody = [
    CLAUDE_MANAGED_BLOCK_START,
    '## mind Memory Protocol (managed)',
    '',
    `Source: ${instructionPath}`,
    '',
    renderMemoryProtocol('claude-code').trim(),
    CLAUDE_MANAGED_BLOCK_END,
  ].join('\n');

  const next = upsertManagedBlock(current, managedBody);
  writeText(claudeMdPath, next);
}

function ensureCodexManagedInstructions(): void {
  const codexDir = path.join(getHomeDir(), '.codex');
  const agentsPath = path.join(codexDir, 'AGENTS.md');

  ensureDir(codexDir);
  removeLegacyProtocolFiles(codexDir);
  const current = readText(agentsPath);

  const managedBody = [
    CLAUDE_MANAGED_BLOCK_START,
    '## mind Memory Protocol (managed)',
    '',
    renderMemoryProtocol('codex').trim(),
    CLAUDE_MANAGED_BLOCK_END,
  ].join('\n');

  const next = upsertManagedBlock(current, managedBody);
  writeText(agentsPath, next);
}

function shouldEnableClaudeHooks(): boolean {
  const value = (process.env[CLAUDE_HOOKS_OPT_IN_ENV] ?? '').trim().toLowerCase();
  return value === '1' || value === 'true' || value === 'yes';
}

function ensureExecutableScript(filePath: string, content: string): string {
  writeText(filePath, content);
  fs.chmodSync(filePath, 0o755);
  return filePath;
}

function ensureClaudeHookScript(): string {
  const hooksDir = path.join(getHomeDir(), '.claude', 'hooks');
  ensureDir(hooksDir);

  const scriptPath = path.join(hooksDir, CLAUDE_HOOK_SCRIPT_NAME);
  const script = `#!/usr/bin/env bash
set -euo pipefail

if ! command -v mind >/dev/null 2>&1; then
  exit 0
fi

PROJECT_SPACE="\${MIND_PROJECT_SPACE:-projects/unknown}"
SUMMARY="\${CLAUDE_SESSION_SUMMARY:-Claude session closed. Capture summary via checkpoint and memory tools.}"

mind checkpoint set "$PROJECT_SPACE" "Session close" "Review summary and persist key learnings" --notes "$SUMMARY" >/dev/null 2>&1 || true
`;

  return ensureExecutableScript(scriptPath, script);
}

function ensureCursorHookScript(): string {
  const hooksDir = path.join(getHomeDir(), '.cursor', 'hooks');
  ensureDir(hooksDir);

  const scriptPath = path.join(hooksDir, CURSOR_HOOK_SCRIPT_NAME);
  const script = `#!/usr/bin/env bash
set -euo pipefail

if ! command -v mind >/dev/null 2>&1; then
  exit 0
fi

EVENT="\${1:-\${CURSOR_HOOK_EVENT:-unknown}}"
PROJECT_SPACE="\${MIND_PROJECT_SPACE:-projects/unknown}"

case "$EVENT" in
  sessionStart)
    mind checkpoint set "$PROJECT_SPACE" "Cursor session start" "Capture active goal and pending work" --notes "cursor:event=sessionStart" >/dev/null 2>&1 || true
    ;;
  preCompact)
    mind checkpoint set "$PROJECT_SPACE" "Cursor pre-compact" "Snapshot context before compaction" --notes "cursor:event=preCompact" >/dev/null 2>&1 || true
    ;;
  stop)
    mind checkpoint set "$PROJECT_SPACE" "Cursor session stop" "Persist final continuity notes" --notes "cursor:event=stop" >/dev/null 2>&1 || true
    ;;
  *)
    exit 0
    ;;
esac
`;

  return ensureExecutableScript(scriptPath, script);
}

function withCursorHooksConfig(
  config: Record<string, unknown>,
  hookScriptPath: string
): Record<string, unknown> {
  const next = { ...config };

  for (const eventName of CURSOR_HOOK_EVENTS) {
    const existing = Array.isArray(next[eventName]) ? (next[eventName] as Array<unknown>) : [];

    const isManagedEntry = (entry: unknown): boolean => {
      if (!entry || typeof entry !== 'object') {
        return false;
      }

      const candidate = entry as { command?: string; args?: unknown };
      return (
        candidate.command === hookScriptPath &&
        Array.isArray(candidate.args) &&
        candidate.args.length === 1 &&
        candidate.args[0] === eventName
      );
    };

    const managedEntry = {
      command: hookScriptPath,
      args: [eventName],
    };

    const withoutManaged = existing.filter(entry => !isManagedEntry(entry));

    next[eventName] = [...withoutManaged, managedEntry];
  }

  return next;
}

function ensureCursorHooksSetup(): void {
  const cursorDir = path.join(getHomeDir(), '.cursor');
  const hooksPath = path.join(cursorDir, 'hooks.json');

  ensureDir(cursorDir);

  const hookScriptPath = ensureCursorHookScript();
  const currentHooks = readJson(hooksPath);
  const mergedHooks = withCursorHooksConfig(currentHooks, hookScriptPath);

  writeJson(hooksPath, mergedHooks);
}

// Helper to extract stop hooks filtering logic ( Task 3.6)
function filterStopHooksForClaude(
  hooks: Array<{ hooks?: Array<{ command?: string }> }>,
  hookScriptPath: string
): Array<{ hooks?: Array<{ command?: string }> } | null> {
  return hooks
    .map(entry => {
      if (!entry || typeof entry !== 'object') {
        return entry;
      }

      const candidate = entry as { hooks?: Array<{ command?: string }> };
      if (!Array.isArray(candidate.hooks)) {
        return entry;
      }

      const sanitizedHooks = candidate.hooks.filter(hook => hook?.command !== hookScriptPath);
      if (sanitizedHooks.length === 0) {
        return null;
      }

      return {
        ...entry,
        hooks: sanitizedHooks,
      };
    })
    .filter(entry => entry !== null);
}

function withClaudeHooksConfig(
  config: Record<string, unknown>,
  hookScriptPath: string
): Record<string, unknown> {
  const hookEntry = {
    matcher: 'session.stop',
    hooks: [
      {
        type: 'command',
        command: hookScriptPath,
      },
    ],
  };

  const hooksRoot =
    config.hooks && typeof config.hooks === 'object' && !Array.isArray(config.hooks)
      ? (config.hooks as Record<string, unknown>)
      : {};

  const stopHooks = Array.isArray(hooksRoot.Stop) ? hooksRoot.Stop : [];
  const nextStopHooks = filterStopHooksForClaude(stopHooks, hookScriptPath);

  nextStopHooks.push(hookEntry);

  return {
    ...config,
    hooks: {
      ...hooksRoot,
      Stop: nextStopHooks,
    },
  };
}

function getMcpPort(): number {
  return Number(process.env.MCP_PORT ?? DEFAULT_MCP_PORT);
}

function getWebPort(): number {
  return Number(process.env.MIND_PORT ?? DEFAULT_PORT);
}

export async function startMcpDetached(): Promise<void> {
  const existingPid = readPid('mcp');
  if (existingPid && isProcessRunning(existingPid)) {
    console.log(`MCP server already running (pid: ${existingPid})`);
    return;
  }

  const bunPath = process.execPath;
  const mindEntry = getMindEntryPath();
  const port = String(getMcpPort());
  const child = spawn(bunPath, ['run', mindEntry, 'mcp', 'start', '--http', '--port', port], {
    detached: true,
    stdio: 'ignore',
  });
  child.unref();

  if (!child.pid) {
    console.log('Failed to start MCP server');
    return;
  }

  await new Promise(resolve => setTimeout(resolve, 500));
  if (!isProcessRunning(child.pid)) {
    console.log(
      'Failed to start MCP server (process exited immediately). Check port availability.'
    );
    return;
  }

  writePid('mcp', child.pid);
  console.log(`✅ MCP server started (pid: ${child.pid}) on http://localhost:${port}/mcp`);
}

export async function stopMcp(): Promise<void> {
  const pid = readPid('mcp');
  if (!pid) {
    console.log('MCP server not running');
    return;
  }

  if (!isProcessRunning(pid)) {
    clearPid('mcp');
    console.log('MCP server not running');
    return;
  }

  process.kill(pid, 'SIGTERM');
  clearPid('mcp');
  console.log(`✅ MCP server stopped (pid: ${pid})`);
}

export async function startServeDetached(port?: number): Promise<void> {
  const existingPid = readPid('serve');
  if (existingPid && isProcessRunning(existingPid)) {
    console.log(`Web server already running (pid: ${existingPid})`);
    return;
  }

  const bunPath = process.execPath;
  const mindEntry = getMindEntryPath();
  const finalPort = String(port ?? getWebPort());
  const child = spawn(bunPath, ['run', mindEntry, 'serve', 'start', '--port', finalPort], {
    detached: true,
    stdio: 'ignore',
  });
  child.unref();

  if (!child.pid) {
    console.log('Failed to start web server');
    return;
  }

  await new Promise(resolve => setTimeout(resolve, 500));
  if (!isProcessRunning(child.pid)) {
    console.log(
      'Failed to start web server (process exited immediately). Check port availability.'
    );
    return;
  }

  writePid('serve', child.pid);
  console.log(`✅ Web server started (pid: ${child.pid}) on http://localhost:${finalPort}`);
}

export async function stopServe(): Promise<void> {
  const pid = readPid('serve');
  if (!pid) {
    console.log('Web server not running');
    return;
  }

  if (!isProcessRunning(pid)) {
    clearPid('serve');
    console.log('Web server not running');
    return;
  }

  process.kill(pid, 'SIGTERM');
  clearPid('serve');
  console.log(`✅ Web server stopped (pid: ${pid})`);
}

export async function statusServers(): Promise<void> {
  const mcpPid = readPid('mcp');
  const servePid = readPid('serve');
  const mcpStatus = mcpPid && isProcessRunning(mcpPid) ? `running (pid: ${mcpPid})` : 'stopped';
  const serveStatus =
    servePid && isProcessRunning(servePid) ? `running (pid: ${servePid})` : 'stopped';

  console.log('Mind Servers Status:');
  console.log(`  MCP:  ${mcpStatus}  -> http://localhost:${getMcpPort()}/mcp`);
  console.log(`  Web:  ${serveStatus}  -> http://localhost:${getWebPort()}`);
}

// getAgentConfig is now imported from ../setup/agent-config

function printCapabilityDiagnostics(capabilities: CapabilityMap): void {
  console.log(`   ${formatCapabilityBadge('L1_MCP', capabilities.L1_MCP)}`);
  console.log(`   ${formatCapabilityBadge('L2_INSTRUCTIONS', capabilities.L2_INSTRUCTIONS)}`);
  console.log(`   ${formatCapabilityBadge('L3_HOOKS', capabilities.L3_HOOKS)}`);
}

// Agent-specific setup handlers (Task 3.4)
async function setupOpenCode(
  merged: Record<string, unknown>,
  mindPath: string
): Promise<Record<string, unknown>> {
  const instructionsPath = ensureOpenCodeInstructionPath();
  let result = placeInstructionFirst(merged, instructionsPath);

  try {
    ensureOpenCodeAutomationPlugin(mindPath);
    console.log(`✅ OpenCode automation plugin configured`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.log(`⚠️ OpenCode plugin failed: ${message}`);
  }

  // Install mind-management skill
  try {
    const skillPath = ensureMindManagementSkill('opencode');
    if (skillPath) {
      console.log(`✅ mind-management skill installed`);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.log(`⚠️ skill installation failed: ${message}`);
  }

  return result;
}

async function setupClaudeCode(
  merged: Record<string, unknown>,
  _mindPath: string
): Promise<Record<string, unknown>> {
  const instructionsPath = ensureClaudeInstructionPath();
  ensureClaudeManagedInstructions(instructionsPath);
  console.log(`✅ Claude Code protocol instructions configured`);

  // Install mind-management skill
  try {
    const skillPath = ensureMindManagementSkill('claude-code');
    if (skillPath) {
      console.log(`✅ mind-management skill installed`);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.log(`⚠️ skill installation failed: ${message}`);
  }

  if (shouldEnableClaudeHooks()) {
    try {
      const hookScriptPath = ensureClaudeHookScript();
      merged = withClaudeHooksConfig(merged, hookScriptPath);
      console.log(`✅ Claude hooks opt-in enabled`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.log(`⚠️ hooks setup failed: ${message}`);
    }
  } else {
    console.log(`ℹ️ Claude hooks opt-in (set ${CLAUDE_HOOKS_OPT_IN_ENV}=true to enable)`);
  }

  return merged;
}

async function setupCursor(merged: Record<string, unknown>): Promise<Record<string, unknown>> {
  try {
    ensureCursorHooksSetup();
    console.log(`✅ Cursor global hooks configured`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.log(`⚠️ hooks setup failed: ${message}`);
  }

  // Install mind-management skill
  try {
    const skillPath = ensureMindManagementSkill('cursor');
    if (skillPath) {
      console.log(`✅ mind-management skill installed`);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.log(`⚠️ skill installation failed: ${message}`);
  }

  return merged;
}

async function setupCodex(_configPath: string, _snippet: string): Promise<void> {
  ensureCodexManagedInstructions();
  console.log(`✅ Codex AGENTS protocol configured`);

  // Install mind-management skill (shared ~/.agents/skills for cross-agent compatibility)
  try {
    const skillPath = ensureMindManagementSkill('codex');
    if (skillPath) {
      console.log(`✅ mind-management skill installed`);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.log(`⚠️ skill installation failed: ${message}`);
  }
}

async function setupWindsurf(): Promise<void> {
  // Install mind-management skill (shared ~/.agents/skills for cross-agent compatibility)
  try {
    const skillPath = ensureMindManagementSkill('windsurf');
    if (skillPath) {
      console.log(`✅ mind-management skill installed`);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.log(`⚠️ skill installation failed: ${message}`);
  }
}

async function setupGeminiCli(): Promise<void> {
  // Install mind-management skill
  try {
    const skillPath = ensureMindManagementSkill('gemini-cli');
    if (skillPath) {
      console.log(`✅ mind-management skill installed`);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.log(`⚠️ skill installation failed: ${message}`);
  }
}

async function setupVscode(): Promise<void> {
  // Install mind-management skill (shared ~/.agents/skills for cross-agent compatibility)
  try {
    const skillPath = ensureMindManagementSkill('vscode');
    if (skillPath) {
      console.log(`✅ mind-management skill installed`);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.log(`⚠️ skill installation failed: ${message}`);
  }
}

async function setupAntigravity(): Promise<void> {
  // Install mind-management skill at ~/.gemini/antigravity/skills/mind-management/
  try {
    const skillPath = ensureMindManagementSkill('antigravity');
    if (skillPath) {
      console.log(`✅ mind-management skill installed`);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.log(`⚠️ skill installation failed: ${message}`);
  }
}

// Agents that use stdio transport and need URL field removed
const STDIO_TRANSPORT_AGENTS: SupportedAgent[] = [
  'claude-code',
  'cursor',
  'windsurf',
  'gemini-cli',
  'vscode',
  'antigravity',
];

function removeLegacyUrlField(merged: Record<string, unknown>): void {
  const mcpServers = (merged as Record<string, unknown>).mcpServers as
    | Record<string, unknown>
    | undefined;
  if (mcpServers?.mind) {
    delete (mcpServers.mind as Record<string, unknown>).url;
  }
}

export async function runSetup(agent: SupportedAgent): Promise<void> {
  const cfg = getAgentConfig(agent);
  const mcpUrl = `http://localhost:${getMcpPort()}/mcp`;
  const mindPath = getMindScriptPath();

  // Track claude-code CLI-first approach
  let claudeCliSucceeded = false;
  let claudeFallbackWritePath: string | undefined;

  if (cfg.format === 'json') {
    // For claude-code, try official CLI first before building merged config
    if (agent === 'claude-code') {
      const cliResult = tryClaudeMcpAdd(mindPath);

      if (cliResult.ok) {
        console.log('  - mind MCP registered via claude mcp add');
        claudeCliSucceeded = true;
      } else {
        console.warn(`  - claude mcp add: ${cliResult.reason}`);
        console.warn('  - Falling back to JSON config...');
        claudeFallbackWritePath = path.join(getHomeDir(), '.claude.json');
      }
    }

    // For claude-code fallback path: read from fallback if it exists, otherwise from primary config
    // This ensures existing config (e.g., theme, github server) is preserved when merging
    let readPath = cfg.configPath;
    if (claudeFallbackWritePath) {
      readPath = fs.existsSync(claudeFallbackWritePath) ? claudeFallbackWritePath : cfg.configPath;
    } else if (agent !== 'claude-code') {
      readPath = cfg.configPath;
    }
    let merged = deepMerge(
      readJson(readPath),
      cfg.build(mcpUrl, mindPath) as Record<string, unknown>
    );

    // Delegate to agent-specific handlers
    if (agent === 'opencode') {
      merged = await setupOpenCode(merged, mindPath);
    } else if (agent === 'claude-code') {
      merged = await setupClaudeCode(merged, mindPath);
    } else if (agent === 'cursor') {
      merged = await setupCursor(merged);
    } else if (agent === 'windsurf') {
      await setupWindsurf();
    } else if (agent === 'gemini-cli') {
      await setupGeminiCli();
    } else if (agent === 'vscode') {
      await setupVscode();
    } else if (agent === 'antigravity') {
      await setupAntigravity();
    }

    // For stdio transport agents, remove any leftover url field
    if (STDIO_TRANSPORT_AGENTS.includes(agent)) {
      removeLegacyUrlField(merged);
    }

    // For claude-code: skip write if CLI succeeded (CLI handles MCP registration)
    // If CLI failed, write to fallback path (~/.claude.json) instead of settings.json
    if (claudeCliSucceeded) {
      // CLI handled MCP registration, nothing to write
    } else {
      const writePath = claudeFallbackWritePath ?? cfg.configPath;
      writeJson(writePath, merged);
    }
  } else {
    const current = readText(cfg.configPath);
    const snippet = cfg.build(mcpUrl, mindPath) as string;
    const merged = current.includes('[mcp_servers.mind]') ? current : `${current}${snippet}`;
    writeText(cfg.configPath, merged);

    if (agent === 'codex') {
      await setupCodex(cfg.configPath, snippet);
    }
  }

  console.log(`✅ Setup complete for ${cfg.name}`);
  if (!claudeCliSucceeded) {
    if (claudeFallbackWritePath) {
      console.log(`   Config written to ~/.claude.json`);
    } else {
      console.log(`   Config updated`);
    }
  }
  printCapabilityDiagnostics(cfg.capabilities);
}

function getAgentBadge(status: 'supported' | 'unsupported' | 'unverified'): string {
  return status === 'supported' ? '✅' : status === 'unverified' ? '⚠️' : '🔮';
}

function getCapabilityBadge(
  level: 'L1_MCP' | 'L2_INSTRUCTIONS' | 'L3_HOOKS',
  capabilities: CapabilityMap
): string {
  const cap = capabilities[level];
  if (cap.status === 'supported') return '✅';
  if (cap.status === 'unverified') return '⚠️';
  return '❌';
}

function formatAgentRow(agent: string, name: string, capabilities: CapabilityMap): string {
  // Determine overall badge based on L1_MCP support (L1 is required)
  const overallBadge = getAgentBadge(
    agent.includes('experimental')
      ? 'unverified'
      : agent.includes('roadmap')
        ? 'unsupported'
        : capabilities.L1_MCP.status
  );
  const l1 = getCapabilityBadge('L1_MCP', capabilities);
  const l2 = getCapabilityBadge('L2_INSTRUCTIONS', capabilities);
  const l3 = getCapabilityBadge('L3_HOOKS', capabilities);

  // Truncate name to 12 chars for alignment
  const shortName = name.length > 12 ? name.slice(0, 11) + '…' : name.padEnd(12);
  return `   ${overallBadge} ${shortName}  L1 ${l1}  L2 ${l2}  L3 ${l3}`;
}

export function listAgents(): void {
  console.log('🧠 Available Agents\n');

  for (const { agent, name, capabilities } of getAgentCapabilityMatrix()) {
    console.log(formatAgentRow(agent, name, capabilities));
  }
}
