import { describe, expect, it } from 'vitest';
import type { ModelMessage } from 'ai';
import { collapseMessages, reflexPrepareStep, withReflex } from '../src/adapters/ai-sdk.js';
import { Reflex } from '../src/critic.js';

const toolMsg = (id: string, text: string): ModelMessage => ({ role: 'tool', content: [{ type: 'tool-result', toolCallId: id, toolName: 'read', output: { type: 'text', value: text } }] });

describe('collapseMessages', () => {
  it('collapses only unreferenced, large-enough results and never mutates input', () => {
    const msgs: ModelMessage[] = [{ role: 'user', content: 'go' }, toolMsg('a', 'x'.repeat(500)), toolMsg('b', 'y'.repeat(500)), toolMsg('c', 'z')];
    const r = collapseMessages(msgs, new Set(['a', 'c']));
    expect(r.collapsed).toBe(1);
    expect(r.savedBytes).toBe(500);
    expect((r.messages[1] as { content: { output: { value: string } }[] }).content[0]!.output.value).toContain('[reflex] read result collapsed');
    expect((msgs[1] as { content: { output: { value: string } }[] }).content[0]!.output.value).toBe('x'.repeat(500));
    expect(r.messages[2]).toBe(msgs[2]);
  });
});

describe('withReflex + reflexPrepareStep', () => {
  it('runs the critic around execute and collapses at checkpoints', async () => {
    const r = new Reflex({ cwd: '/p', config: { mode: 'enforce' }, goal: 'Find handleRedirect. Do not push.' });
    let n = 0;
    const tools = withReflex({
      read: { description: 'read', inputSchema: {}, execute: async ({ path }: { path: string }) => `contents of ${path}: ${'filler_'.repeat(60)}` },
      bash: { description: 'bash', inputSchema: {}, execute: async () => 'pushed' },
    } as never, r);
    const read = (tools as Record<string, { execute: (i: unknown, o: { toolCallId: string }) => Promise<string> }>)['read']!;
    const bash = (tools as Record<string, { execute: (i: unknown, o: { toolCallId: string }) => Promise<string> }>)['bash']!;
    const a = await read.execute({ path: 'a.ts' }, { toolCallId: `c${++n}` });
    expect(a).toContain('contents of a.ts');
    const dup = await read.execute({ path: 'a.ts' }, { toolCallId: `c${++n}` });
    expect(dup).toContain('[reflex]'); // exact duplicate denied with reason
    const pushed = await bash.execute({ command: 'git push --force' }, { toolCallId: `c${++n}` });
    expect(pushed).toContain('not approved');
    for (let i = 0; i < 8; i++) await read.execute({ path: `f${i}.ts` }, { toolCallId: `c${++n}` });
    const msgs: ModelMessage[] = [{ role: 'user', content: 'go' }, toolMsg('c1', 'contents of a.ts ' + 'filler_'.repeat(60)), toolMsg('c4', 'contents of f0.ts ' + 'filler_'.repeat(60))];
    const prep = reflexPrepareStep(r, { after: 3, checkpointEvery: 5 });
    expect(prep({ stepNumber: 4, messages: msgs })).toBeUndefined();
    const at5 = prep({ stepNumber: 5, messages: msgs });
    expect(at5?.messages).toBeDefined();
    expect(JSON.stringify(at5!.messages)).toContain('collapsed');
  });
});
