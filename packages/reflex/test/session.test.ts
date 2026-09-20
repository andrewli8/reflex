import { describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendEvent, readTail } from '../src/session.js';
import { Reflex, foldEvents, type ReflexEvent } from '../src/critic.js';

describe('session log', () => {
  it('round-trips events and folds outcomes; parallel appends all survive', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'reflex-')), 's.jsonl');
    const r = new Reflex({ cwd: '/p', config: { mode: 'enforce' }, log: (e) => appendEvent(path, e) });
    const c = { toolUseId: 't1', tool: 'Read', args: { file_path: 'a.ts' } };
    await r.pre(c); await r.post(c, { output: 'hello' });
    await Promise.all(Array.from({ length: 20 }, (_, i) => Promise.resolve().then(() => appendEvent(path, { ts: i, step: 99, toolUseId: `x${i}`, tool: 'Bash', class: '', summary: '', phase: 'permission', policy: 'keep', applied: 'keep', source: 'deterministic' }))));
    const events = readTail(path);
    expect(events.length).toBe(22);
    const { actions } = foldEvents(events);
    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({ tool: 'Read', outcome: 'ok', resultDigest: 'hello' });
    const r2 = new Reflex({ cwd: '/p', config: { mode: 'enforce' }, history: events });
    expect((await r2.pre({ toolUseId: 't2', tool: 'Read', args: { file_path: './a.ts' } })).policy.kind).toBe('skip');
  });

  it('readTail keeps the meta line from the head of a long log', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'reflex-')), 's.jsonl');
    appendEvent(path, { ts: 0, step: 0, toolUseId: '', tool: '', class: '', summary: '', phase: 'meta', policy: 'keep', applied: 'keep', source: 'deterministic', goal: 'the goal' });
    for (let i = 0; i < 2000; i++) appendEvent(path, { ts: i, step: i, toolUseId: `t${i}`, tool: 'Read', class: 'read', summary: 'x'.repeat(100), phase: 'pre', policy: 'execute', applied: 'execute', source: 'deterministic' } as ReflexEvent);
    const tail = readTail(path, 8 * 1024);
    expect(tail[0]).toMatchObject({ phase: 'meta', goal: 'the goal' });
    expect(foldEvents(tail).goal).toBe('the goal');
  });
  it('readTail drops a torn first line', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'reflex-')), 's.jsonl');
    for (let i = 0; i < 2000; i++) appendEvent(path, { ts: i, step: i, toolUseId: `t${i}`, tool: 'Read', class: 'read', summary: 'x'.repeat(100), phase: 'pre', policy: 'execute', applied: 'execute', source: 'deterministic' } as ReflexEvent);
    const tail = readTail(path, 8 * 1024);
    expect(tail.length).toBeGreaterThan(10);
    expect(tail.every((e) => typeof e.step === 'number')).toBe(true);
    expect(tail.at(-1)?.step).toBe(1999);
  });
});
