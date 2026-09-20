import { describe, expect, it } from 'vitest';
import { findCycle, detectFlags } from '../src/detect.js';
import { makeAction } from '../src/state.js';

const cwd = '/p';
const act = (tool: string, args: Record<string, unknown>, step: number) =>
  ({ ...makeAction(tool, args, cwd, step), outcome: 'ok' as const });

describe('findCycle', () => {
  it('finds a length-2 cycle repeated 3 times', () => {
    const sigs = ['a', 'b', 'a', 'b', 'a', 'b'];
    expect(findCycle(sigs, { maxLen: 5, minRepeats: 3, window: 25 })).toBe(2);
  });
  it('ignores non-repeating tails', () => {
    expect(findCycle(['a', 'b', 'a', 'b', 'c'], { maxLen: 5, minRepeats: 3, window: 25 })).toBe(0);
  });
});

describe('detectFlags', () => {
  it('flags exact duplicate when no mutation intervened', () => {
    const recent = [act('Read', { file_path: 'a.ts' }, 1), act('Grep', { pattern: 'x' }, 2)];
    const f = detectFlags(recent, makeAction('Read', { file_path: './a.ts' }, cwd, 3));
    expect(f.exactDuplicate).toBe(true);
  });
  it('clears duplicate after a mutation of the same path', () => {
    const recent = [act('Read', { file_path: 'a.ts' }, 1), act('Edit', { file_path: 'a.ts' }, 2)];
    const f = detectFlags(recent, makeAction('Read', { file_path: 'a.ts' }, cwd, 3));
    expect(f.exactDuplicate).toBe(false);
  });
  it('keeps a file-read duplicate across a pathless exec but clears it on a write to that file', () => {
    const recent = [act('Read', { file_path: 'a.ts' }, 1), act('Bash', { command: 'npm test' }, 2)];
    expect(detectFlags(recent, makeAction('Read', { file_path: 'a.ts' }, cwd, 3)).exactDuplicate).toBe(true);
    const recent2 = [act('Grep', { pattern: 'x' }, 1), act('Write', { file_path: 'b.ts' }, 2)];
    expect(detectFlags(recent2, makeAction('Grep', { pattern: 'x' }, cwd, 3)).exactDuplicate).toBe(false);
  });
  it('browser reads are cleared by a click on the same MCP server, and empty results are never a duplicate basis', () => {
    const page = (n: number) => act('mcp__claude-in-chrome__read_page', { filter: 'all' }, n);
    const click = { ...act('mcp__claude-in-chrome__computer', { action: 'left_click' }, 2), readOnly: false, class: 'exec' as const };
    expect(detectFlags([page(1), click], makeAction('mcp__claude-in-chrome__read_page', { filter: 'all' }, cwd, 3)).exactDuplicate).toBe(false);
    expect(detectFlags([page(1)], makeAction('mcp__claude-in-chrome__read_page', { filter: 'all' }, cwd, 2)).exactDuplicate).toBe(true);
    const shot = { ...act('Read', { file_path: 'shot.png' }, 1), resultDigest: '' };
    expect(detectFlags([shot], makeAction('Read', { file_path: 'shot.png' }, cwd, 2)).exactDuplicate).toBe(false);
  });
  it('flags near duplicate on similar args', () => {
    const recent = [act('Grep', { pattern: 'login redirect', path: 'src' }, 1)];
    const f = detectFlags(recent, makeAction('Grep', { pattern: 'login redirect', path: 'src', '-i': true }, cwd, 2));
    expect(f.nearDuplicate).toBe(true);
  });
  it('flags stuck on three consecutive identical calls', () => {
    const recent = [act('Bash', { command: 'npm test' }, 1), act('Bash', { command: 'npm test' }, 2)];
    const f = detectFlags(recent, makeAction('Bash', { command: 'npm test' }, cwd, 3));
    expect(f.stuck).toBe(true);
  });
});
