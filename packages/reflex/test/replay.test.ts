import { describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { replayTranscript, formatReport } from '../src/replay.js';
import { identifiers } from '../src/usefulness.js';

const L = (o: object) => JSON.stringify(o);
const use = (id: string, name: string, input: object) => L({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name, input }] } });
const res = (id: string, content: string) => L({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content }] } });
const say = (text: string) => L({ type: 'assistant', message: { content: [{ type: 'text', text }] } });

describe('replay', () => {
  it('labels usefulness and counts would-skip against it', async () => {
    const p = join(mkdtempSync(join(tmpdir(), 'reflex-')), 't.jsonl');
    writeFileSync(p, [
      L({ type: 'user', message: { content: 'Fix the login redirect bug. Do not change auth providers.' } }),
      use('a', 'Read', { file_path: 'src/auth.ts' }), res('a', 'export function handleRedirect(req) { return req.query.next_url }'),
      say('handleRedirect reads next_url; I will grep for it.'),
      use('b', 'Grep', { pattern: 'next_url' }), res('b', 'src/routes.ts:12: next_url'),
      use('c', 'Read', { file_path: 'src/auth.ts' }), res('c', 'export function handleRedirect(req) { return req.query.next_url }'),
      use('d', 'Read', { file_path: 'README.md' }), res('d', 'Runs on Kubernetes with helm charts under k8s/'),
      use('e', 'Bash', { command: 'git push --force' }), res('e', 'done'),
      say('Done.'),
    ].join('\n') + '\n');
    const r = await replayTranscript(p, { cwd: '/p' });
    expect(r.calls).toBe(5);
    expect(r.rows.find((x) => x.toolUseId === 'a')?.useful).toBe(true);   // handleRedirect / next_url used later
    expect(r.rows.find((x) => x.toolUseId === 'd')?.useful).toBe(false);  // Kubernetes never referenced
    expect(r.rows.find((x) => x.toolUseId === 'c')?.policy).toBe('skip'); // exact duplicate read
    expect(r.rows.find((x) => x.toolUseId === 'e')?.policy).toBe('ask');
    expect(r.wouldSkip).toBe(1);
    expect(r.falseVetoes).toBe(0);
    expect(formatReport([r])).toContain('would have skipped 1 of 5');
  });
  it('identifier filter drops plain prose', () => {
    const ids = [...identifiers('the quick brown fox handleRedirect src/auth.ts v2')];
    expect(ids).toEqual(expect.arrayContaining(['handleRedirect', 'src/auth.ts', 'auth.ts']));
    expect(ids).not.toContain('quick');
  });
});
