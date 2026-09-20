import { describe, expect, it } from 'vitest';
import { jevProvider } from '../src/providers/jev.js';

describe('jev provider', () => {
  it('maps boolean to noul and normalizes answers', async () => {
    let sent: unknown;
    const f = (async (_url: string, init: RequestInit) => {
      sent = JSON.parse(String(init.body));
      return new Response(JSON.stringify({ answers: { r: { type: 'noul', noul: 0.93 }, c: { type: 'choice', choice: 'a', confidence: 0.8, probabilities: { a: 0.8, b: 0.2 } }, s: { type: 'score', score: 1.5, confidence: 0.6, probabilities: { '0': 0.1, '1': 0.3, '2': 0.6 } } } }), { status: 200 });
    }) as unknown as typeof fetch;
    const p = jevProvider({ apiKey: 'k', fetch: f });
    const a = await p.decide('S', { r: { type: 'boolean', instructions: 'q' }, c: { type: 'choice', instructions: 'q', criteria: { a: 'A', b: 'B' } }, s: { type: 'score', instructions: 'q', criteria: ['lo', 'mid', 'hi'] } });
    expect((sent as { questions: { r: { type: string } } }).questions.r.type).toBe('noul');
    expect(a.r).toEqual({ type: 'boolean', p: 0.93 });
    expect(a.c).toMatchObject({ type: 'choice', choice: 'a', confidence: 0.8 });
    expect(a.s).toMatchObject({ type: 'score', score: 1.5, probabilities: [0.1, 0.3, 0.6] });
  });
  it('retries once on 429 honouring retry-after', async () => {
    let n = 0;
    const f = (async () => (++n === 1 ? new Response('slow', { status: 429, headers: { 'retry-after': '0.1' } }) : new Response(JSON.stringify({ answers: { r: { type: 'noul', noul: 0.4 } } }), { status: 200 }))) as unknown as typeof fetch;
    const a = await jevProvider({ apiKey: 'k', fetch: f }).decide('s', { r: { type: 'boolean', instructions: 'q' } });
    expect(n).toBe(2);
    expect(a.r).toEqual({ type: 'boolean', p: 0.4 });
  });
  it('fails without a key and on non-2xx', async () => {
    await expect(jevProvider({ apiKey: '' }).decide('s', {})).rejects.toThrow('TYPESAFE_API_KEY');
    const f = (async () => new Response('nope', { status: 429 })) as unknown as typeof fetch;
    await expect(jevProvider({ apiKey: 'k', fetch: f }).decide('s', {})).rejects.toThrow('jev 429');
  });
});
