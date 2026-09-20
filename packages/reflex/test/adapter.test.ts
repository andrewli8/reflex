import { beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { handleHook, type HookInput } from '../src/adapters/claude-code.js';
import { init, initCodex } from '../src/cli.js';

let home: string; let cwd: string; let transcript: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'reflex-home-')); process.env['REFLEX_HOME'] = home;
  cwd = mkdtempSync(join(tmpdir(), 'reflex-proj-'));
  transcript = join(cwd, 't.jsonl');
  writeFileSync(transcript, JSON.stringify({ type: 'user', message: { role: 'user', content: 'Fix the bug. Do not touch auth.' } }) + '\n');
});
const base = (over: object): HookInput => ({ session_id: 's1', cwd, transcript_path: transcript, ...over } as HookInput);

describe('claude-code adapter', () => {
  it('nudges a duplicate read by default and denies in enforce', async () => {
    const read = (id: string) => base({ hook_event_name: 'PreToolUse', tool_use_id: id, tool_name: 'Read', tool_input: { file_path: 'a.ts' } });
    expect(await handleHook(read('t1'))).toBeUndefined();
    await handleHook(base({ hook_event_name: 'PostToolUse', tool_use_id: 't1', tool_name: 'Read', tool_input: { file_path: 'a.ts' }, tool_response: 'x' }));
    const nudge = await handleHook(read('t2'));
    expect(nudge?.hookSpecificOutput).toMatchObject({ hookEventName: 'PreToolUse', additionalContext: expect.stringContaining('[reflex]') });
    expect(nudge?.hookSpecificOutput?.['permissionDecision']).toBeUndefined();
    writeFileSync(join(cwd, 'reflex.config.json'), JSON.stringify({ mode: 'enforce' }));
    const deny = await handleHook(read('t3'));
    expect(deny?.hookSpecificOutput).toMatchObject({ permissionDecision: 'deny', permissionDecisionReason: expect.stringContaining('reflex:force') });
    const log = readFileSync(join(home, 'sessions', 's1.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(log[0]).toMatchObject({ phase: 'meta', goal: 'Fix the bug. Do not touch auth.' });
  });

  it('asks on a force push even in nudge mode and records the permission event', async () => {
    const out = await handleHook(base({ hook_event_name: 'PreToolUse', tool_use_id: 'p1', tool_name: 'Bash', tool_input: { command: 'git push --force' } }));
    expect(out?.hookSpecificOutput).toMatchObject({ permissionDecision: 'ask' });
    expect(await handleHook(base({ hook_event_name: 'PermissionRequest', tool_use_id: 'p1', tool_name: 'Bash', tool_input: { command: 'git push --force' } }))).toBeUndefined();
    const log = readFileSync(join(home, 'sessions', 's1.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(log.some((e) => e.phase === 'permission' && e.toolUseId === 'p1')).toBe(true);
  });

  it('trims a large duplicate result in the original shape', async () => {
    const big = 'line\n'.repeat(1000);
    for (const id of ['r1', 'r2']) {
      await handleHook(base({ hook_event_name: 'PreToolUse', tool_use_id: id, tool_name: 'Bash', tool_input: { command: `cat ${id}.log` } }));
    }
    expect(await handleHook(base({ hook_event_name: 'PostToolUse', tool_use_id: 'r1', tool_name: 'Bash', tool_input: { command: 'cat r1.log' }, tool_response: { stdout: big, stderr: '' } }))).toBeUndefined();
    const out = await handleHook(base({ hook_event_name: 'PostToolUse', tool_use_id: 'r2', tool_name: 'Bash', tool_input: { command: 'cat r2.log' }, tool_response: { stdout: big, stderr: '' } }));
    const upd = out?.hookSpecificOutput?.['updatedResponse'] as { stdout: string; stderr: string };
    expect(upd.stderr).toBe('');
    expect(upd.stdout).toContain('[reflex] trimmed');
  });

  it('never throws on garbage input', async () => {
    expect(await handleHook({ hook_event_name: 'PreToolUse', session_id: 'x' } as never)).toBeUndefined();
  });
});

describe('UserPromptSubmit', () => {
  it('restates constraints from the goal on every prompt', async () => {
    await handleHook(base({ hook_event_name: 'PreToolUse', tool_use_id: 'u1', tool_name: 'Read', tool_input: { file_path: 'a.ts' } }));
    const out = await handleHook(base({ hook_event_name: 'UserPromptSubmit', prompt: 'now also never delete migrations' }));
    expect(out?.hookSpecificOutput?.['additionalContext']).toContain('Do not touch auth');
    expect(out?.hookSpecificOutput?.['additionalContext']).toContain('never delete migrations');
  });
});

describe('SessionStart ledger', () => {
  it('injects the ledger after compaction but not on a fresh start', async () => {
    const c = base({ hook_event_name: 'PreToolUse', tool_use_id: 'l1', tool_name: 'Read', tool_input: { file_path: 'a.ts' } });
    await handleHook(c);
    await handleHook(base({ hook_event_name: 'PostToolUse', tool_use_id: 'l1', tool_name: 'Read', tool_input: { file_path: 'a.ts' }, tool_response: 'export const thing = 1;' }));
    expect(await handleHook(base({ hook_event_name: 'SessionStart', source: 'startup' }))).toBeUndefined();
    const out = await handleHook(base({ hook_event_name: 'SessionStart', source: 'compact' }));
    expect(out?.hookSpecificOutput?.['additionalContext']).toContain('Session ledger');
    expect(out?.hookSpecificOutput?.['additionalContext']).toContain('a.ts');
  });
});

describe('codex host', () => {
  it('takes the goal from the first prompt, turns ask into a note in nudge and a deny in enforce, and never rewrites results', async () => {
    const codex = (over: object): HookInput => ({ session_id: 'cx1', cwd, ...over } as HookInput);
    expect(await handleHook(codex({ hook_event_name: 'UserPromptSubmit', prompt: 'Fix the redirect. Do not touch billing code.' }), 'codex')).toMatchObject({ hookSpecificOutput: { additionalContext: expect.stringContaining('Do not touch billing code') } });
    const push = codex({ hook_event_name: 'PreToolUse', tool_use_id: 'x1', tool_name: 'Bash', tool_input: { command: 'git push --force' } });
    const nudge = await handleHook(push, 'codex');
    expect(nudge?.hookSpecificOutput?.['permissionDecision']).toBeUndefined();
    expect(nudge?.hookSpecificOutput?.['additionalContext']).toContain('Confirm with the user');
    writeFileSync(join(cwd, 'reflex.config.json'), JSON.stringify({ mode: 'enforce' }));
    expect((await handleHook(push, 'codex'))?.hookSpecificOutput).toMatchObject({ permissionDecision: 'deny' });
    const big = 'line\n'.repeat(1000);
    for (const id of ['p1', 'p2']) await handleHook(codex({ hook_event_name: 'PreToolUse', tool_use_id: id, tool_name: 'Bash', tool_input: { command: `cat ${id}.log` } }), 'codex');
    await handleHook(codex({ hook_event_name: 'PostToolUse', tool_use_id: 'p1', tool_name: 'Bash', tool_input: { command: 'cat p1.log' }, tool_response: big }), 'codex');
    expect(await handleHook(codex({ hook_event_name: 'PostToolUse', tool_use_id: 'p2', tool_name: 'Bash', tool_input: { command: 'cat p2.log' }, tool_response: big }), 'codex')).toBeUndefined();
    const log = readFileSync(join(home, 'sessions', 'cx1.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(log[0]).toMatchObject({ phase: 'meta', goal: expect.stringContaining('Fix the redirect') });
    expect(log.some((e) => e.phase === 'post' && e.applied === 'trim')).toBe(true);
  });
  it('apply_patch classifies as a write', async () => {
    const { classify } = await import('../src/classify.js');
    expect(classify('apply_patch', { command: '*** Begin Patch' }, cwd)).toMatchObject({ class: 'write', readOnly: false });
  });
});

describe('init', () => {
  it('adds four hooks once, keeps existing settings, and is idempotent', () => {
    mkdirSync(join(cwd, '.claude'));
    writeFileSync(join(cwd, '.claude', 'settings.json'), '{"permissions":{"allow":["Bash(ls)"]}}');
    const a = init(cwd, 'node /x/hook.js');
    const b = init(cwd, 'node /x/hook.js');
    expect(a.added).toHaveLength(6);
    expect(b.added).toHaveLength(0);
    const s = JSON.parse(readFileSync(a.path, 'utf8'));
    expect(s.hooks.PreToolUse[0].hooks[0]).toMatchObject({ type: 'command', command: 'node /x/hook.js', timeout: 3 });
    expect(s.permissions.allow).toEqual(['Bash(ls)']);
  });
});
