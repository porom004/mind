import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, test } from 'bun:test';

import { renderSystemInstructions } from '../src/cli/system-instructions';
import { createSystemTools } from '../src/mcp/tools/system';

const SYSTEM_INSTRUCTIONS_SOURCE_PATH = join(
  import.meta.dir,
  '..',
  'src',
  'resources',
  'protocols',
  'mind-system-instructions.md'
);

const SYSTEM_INSTRUCTIONS_SNAPSHOT_PATH = join(
  import.meta.dir,
  'snapshots',
  'system-instructions.md'
);

describe('MCP System Tools', () => {
  test('system instructions renderer should match snapshot', () => {
    const snapshotText = readFileSync(SYSTEM_INSTRUCTIONS_SNAPSHOT_PATH, 'utf-8');

    expect(renderSystemInstructions()).toBe(snapshotText);
    expect(renderSystemInstructions()).toBe(snapshotText);
  });

  test('system instructions renderer should be deterministic and equal to canonical source text', () => {
    const sourceText = readFileSync(SYSTEM_INSTRUCTIONS_SOURCE_PATH, 'utf-8');

    expect(renderSystemInstructions()).toBe(sourceText);
    expect(renderSystemInstructions()).toBe(sourceText);
  });

  test('system_instructions MCP contract should remain stable', async () => {
    const tools = createSystemTools();

    expect(Object.keys(tools)).toEqual(['system_instructions']);

    const tool = tools.system_instructions;
    expect(tool.schema.safeParse({}).success).toBe(true);
    expect(tool.schema.safeParse({ anything: 'else' }).success).toBe(true);

    // @ts-ignore — handler accepts 0 args but type system requires 1
    const response = await tool.handler();
    expect(response).toEqual({
      content: [{ type: 'text', text: renderSystemInstructions() }],
      instructions_version: '1.3.0',
    });
  });

  test('system_instructions should load protocol text from markdown source file', async () => {
    const tools = createSystemTools();
    // @ts-ignore — handler accepts 0 args but type system requires 1
    const response = await tools.system_instructions.handler();
    const sourceText = readFileSync(SYSTEM_INSTRUCTIONS_SOURCE_PATH, 'utf-8');

    expect(response.instructions_version).toBe('1.3.0');
    expect(response.content[0]?.type).toBe('text');
    expect(response.content[0]?.text).toBe(sourceText);
  });
});
