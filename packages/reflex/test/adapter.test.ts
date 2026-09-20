import { beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
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
  it('nudges a duplicate read in nudge mode and denies in enforce', async () => {
    writeFileSync(join(cwd, 'reflex.config.json'), JSON.stringify({ mode: 'nudge', provider: 'none' }));
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
    writeFileSync(join(cwd, 'reflex.config.json'), JSON.stringify({ mode: 'nudge', provider: 'none' }));
    const out = await handleHook(base({ hook_event_name: 'PreToolUse', tool_use_id: 'p1', tool_name: 'Bash', tool_input: { command: 'git push --force' } }));
    expect(out?.hookSpecificOutput).toMatchObject({ permissionDecision: 'ask' });
    expect(await handleHook(base({ hook_event_name: 'PermissionRequest', tool_use_id: 'p1', tool_name: 'Bash', tool_input: { command: 'git push --force' } }))).toBeUndefined();
    const log = readFileSync(join(home, 'sessions', 's1.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(log.some((e) => e.phase === 'permission' && e.toolUseId === 'p1')).toBe(true);
  });

  it('trims a large duplicate result in the original shape', async () => {
    writeFileSync(join(cwd, 'reflex.config.json'), JSON.stringify({ provider: 'none' }));
    const big = 'line\n'.repeat(1000);
    for (const id of ['r1', 'r2']) {
      await handleHook(base({ hook_event_name: 'PreToolUse', tool_use_id: id, tool_name: 'Bash', tool_input: { command: `cat ${id}.log` } }));
    }
    expect(await handleHook(base({ hook_event_name: 'PostToolUse', tool_use_id: 'r1', tool_name: 'Bash', tool_input: { command: 'cat r1.log' }, tool_response: { stdout: big, stderr: '' } }))).toBeUndefined();
    const out = await handleHook(base({ hook_event_name: 'PostToolUse', tool_use_id: 'r2', tool_name: 'Bash', tool_input: { command: 'cat r2.log' }, tool_response: { stdout: big, stderr: '' } }));
    const upd = out?.hookSpecificOutput?.['updatedResponse'] as { stdout: string; stderr: string };
    expect(upd.stderr).toBe('');
    expect(upd.stdout).toContain('[reflex] Output identical to step');
  });

  it('never throws on garbage input', async () => {
    expect(await handleHook({ hook_event_name: 'PreToolUse', session_id: 'x' } as never)).toBeUndefined();
  });
});

describe('UserPromptSubmit', () => {
  it('restates constraints from the goal on every prompt', async () => {
    writeFileSync(join(cwd, 'reflex.config.json'), JSON.stringify({ provider: 'none' }));
    await handleHook(base({ hook_event_name: 'PreToolUse', tool_use_id: 'u1', tool_name: 'Read', tool_input: { file_path: 'a.ts' } }));
    const out = await handleHook(base({ hook_event_name: 'UserPromptSubmit', prompt: 'now also never delete migrations' }));
    expect(out?.hookSpecificOutput?.['additionalContext']).toContain('Do not touch auth');
    expect(out?.hookSpecificOutput?.['additionalContext']).toContain('never delete migrations');
  });
});

describe('SessionStart ledger', () => {
  it('injects the ledger after compaction but not on a fresh start', async () => {
    writeFileSync(join(cwd, 'reflex.config.json'), JSON.stringify({ provider: 'none' }));
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
    writeFileSync(join(cwd, 'reflex.config.json'), JSON.stringify({ mode: 'nudge', provider: 'none' }));
    const codex = (over: object): HookInput => ({ session_id: 'cx1', cwd, ...over } as HookInput);
    expect(await handleHook(codex({ hook_event_name: 'UserPromptSubmit', prompt: 'Fix the redirect. Do not touch billing code.' }), 'codex')).toMatchObject({ hookSpecificOutput: { additionalContext: expect.stringContaining('Do not touch billing code') } });
    const push = codex({ hook_event_name: 'PreToolUse', tool_use_id: 'x1', tool_name: 'Bash', tool_input: { command: 'git push --force' } });
    const nudge = await handleHook(push, 'codex');
    expect(nudge?.hookSpecificOutput?.['permissionDecision']).toBeUndefined();
    expect(nudge?.hookSpecificOutput?.['additionalContext']).toContain('Confirm with the user');
    writeFileSync(join(cwd, 'reflex.config.json'), JSON.stringify({ mode: 'enforce', provider: 'none' }));
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

describe('PreCompact', () => {
  it('resets the gauge window at compaction', async () => {
    writeFileSync(join(cwd, 'reflex.config.json'), JSON.stringify({ provider: 'none' }));
    for (let i = 0; i < 3; i++) {
      await handleHook(base({ hook_event_name: 'PreToolUse', tool_use_id: `k${i}`, tool_name: 'Read', tool_input: { file_path: `f${i}.txt` } }));
      await handleHook(base({ hook_event_name: 'PostToolUse', tool_use_id: `k${i}`, tool_name: 'Read', tool_input: { file_path: `f${i}.txt` }, tool_response: `token_${i} ` + 'x'.repeat(3000) }));
    }
    expect(await handleHook(base({ hook_event_name: 'PreCompact', trigger: 'auto' } as object))).toBeUndefined();
    const log = readFileSync(join(home, 'sessions', 's1.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(log.at(-1)).toMatchObject({ phase: 'compact' });
    const { Reflex } = await import('../src/critic.js');
    expect(new Reflex({ cwd, history: log }).deadWeight().results).toBe(0);
  });
});

describe('init', () => {
  it('adds four hooks once, keeps existing settings, and is idempotent', () => {
    mkdirSync(join(cwd, '.claude'));
    writeFileSync(join(cwd, '.claude', 'settings.json'), '{"permissions":{"allow":["Bash(ls)"]}}');
    const a = init(cwd, 'node /x/hook.js');
    const b = init(cwd, 'node /x/hook.js');
    expect(a.added).toHaveLength(7);
    expect(b.added).toHaveLength(0);
    const s = JSON.parse(readFileSync(a.path, 'utf8'));
    expect(s.hooks.PreToolUse[0].hooks[0]).toMatchObject({ type: 'command', command: 'node /x/hook.js', timeout: 3 });
    expect(s.permissions.allow).toEqual(['Bash(ls)']);
  });
});

describe('secrets and shim', () => {
  it('stores and reads a key with 0600 and writes an executable shim', async () => {
    const { readSecret, writeSecret } = await import('../src/session.js');
    const { writeShim } = await import('../src/cli.js');
    const { statSync, readFileSync: rf } = await import('node:fs');
    const p = writeSecret('TYPESAFE_API_KEY', 'k123');
    expect((statSync(p).mode & 0o777)).toBe(0o600);
    expect(readSecret('TYPESAFE_API_KEY')).toBe('k123');
    const shim = writeShim();
    expect(statSync(shim).mode & 0o111).toBeTruthy();
    expect(rf(shim, 'utf8')).toContain('hook-bin.js');
  });
});

describe('transcript containment', () => {
  it('ignores a transcript_path outside ~/.claude, ~/.codex or the project', async () => {
    const { writeFileSync: wf } = await import('node:fs');
    const outside = join(mkdtempSync(join(tmpdir(), 'elsewhere-')), 't.jsonl');
    wf(outside, JSON.stringify({ type: 'user', message: { role: 'user', content: 'Secret goal. Never do X.' } }) + '\n');
    await handleHook({ session_id: 'tc1', cwd, transcript_path: outside, hook_event_name: 'PreToolUse', tool_use_id: 'a', tool_name: 'Read', tool_input: { file_path: 'a.ts' } } as HookInput);
    const log = readFileSync(join(home, 'sessions', 'tc1.jsonl'), 'utf8');
    expect(log).not.toContain('Secret goal');
  });
});

describe('level off and level file loading', () => {
  it('level off makes the hook a no-op and level ask enforces', async () => {
    const { loadConfig } = await import('../src/config-file.js');
    expect(loadConfig(mkdtempSync(join(tmpdir(), 'empty-')))).toMatchObject({ level: 'ask', mode: 'enforce', provider: 'jev' });
    writeFileSync(join(cwd, 'reflex.config.json'), JSON.stringify({ level: 'nudge' }));
    expect(loadConfig(cwd)).toMatchObject({ level: 'ask', mode: 'nudge', provider: 'none' });
    writeFileSync(join(cwd, 'reflex.config.json'), JSON.stringify({ level: 'off' }));
    expect(loadConfig(cwd)).toMatchObject({ level: 'off', mode: 'shadow' });
    const read = base({ hook_event_name: 'PreToolUse', tool_use_id: 'o1', tool_name: 'Bash', tool_input: { command: 'git push --force' } });
    expect(await handleHook(read)).toBeUndefined();
    expect(existsSync(join(home, 'sessions', 's1.jsonl'))).toBe(false);
    writeFileSync(join(cwd, 'reflex.config.json'), JSON.stringify({ level: 'ask', provider: 'none' }));
    expect(loadConfig(cwd)).toMatchObject({ level: 'ask', mode: 'enforce', provider: 'none' });
    expect((await handleHook(read))?.hookSpecificOutput).toMatchObject({ permissionDecision: 'ask' });
    writeFileSync(join(cwd, 'reflex.config.json'), JSON.stringify({ level: 'auto', provider: 'none' }));
    expect((await handleHook({ ...read, tool_use_id: 'o2' }))?.hookSpecificOutput).toMatchObject({ permissionDecision: 'deny' });
  });
});
