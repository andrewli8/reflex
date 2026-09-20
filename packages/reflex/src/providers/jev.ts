import type { Answer, Answers, Provider, Question } from '../provider.js';

/**
 * TypeSafe Jev over HTTP. Request/response shape follows the published SDK examples;
 * endpoint, limits and rate limits are from third-party listings and unverified against docs.typesafe.ai.
 * Set TYPESAFE_API_KEY; override TYPESAFE_BASE_URL / TYPESAFE_MODEL if the listing is wrong.
 */
export interface JevOptions { apiKey?: string; baseUrl?: string; model?: string; fetch?: typeof fetch; maxStateTokens?: number }

type JevAnswer = { type: string; noul?: number; choice?: string; score?: number; confidence?: number; probabilities?: Record<string, number> | number[] };

function toJev(q: Question): Record<string, unknown> {
  if (q.type === 'boolean') return { type: 'noul', instructions: q.instructions, ...(q.criteria ? { criteria: q.criteria } : {}) };
  return { type: q.type, instructions: q.instructions, criteria: q.criteria };
}

export function fromJev(q: Question, a: JevAnswer | undefined): Answer {
  if (q.type === 'boolean') return { type: 'boolean', p: a?.noul ?? 0.5 };
  if (q.type === 'choice') {
    const probabilities = (a?.probabilities as Record<string, number>) ?? {};
    const choice = a?.choice ?? Object.keys(probabilities)[0] ?? '';
    return { type: 'choice', choice, confidence: a?.confidence ?? probabilities[choice] ?? 0, probabilities };
  }
  const p = a?.probabilities;
  const probabilities = Array.isArray(p) ? p : Object.keys(p ?? {}).sort((x, y) => Number(x) - Number(y)).map((k) => (p as Record<string, number>)[k] ?? 0);
  return { type: 'score', score: a?.score ?? 0, confidence: a?.confidence ?? 0, probabilities };
}

export function jevProvider(o: JevOptions = {}): Provider {
  const apiKey = o.apiKey ?? process.env['TYPESAFE_API_KEY'] ?? '';
  const baseUrl = (o.baseUrl ?? process.env['TYPESAFE_BASE_URL'] ?? 'https://api.typesafe.ai').replace(/\/$/, '');
  const model = o.model ?? process.env['TYPESAFE_MODEL'] ?? 'jev-latest';
  const f = o.fetch ?? fetch;
  return {
    name: 'jev',
    maxStateTokens: o.maxStateTokens ?? 8000, // ponytail: well under the listed 32K; keeps latency and cost flat
    async decide<Q extends Record<string, Question>>(state: string, questions: Q, opts?: { signal?: AbortSignal }): Promise<Answers<Q>> {
      if (!apiKey) throw new Error('TYPESAFE_API_KEY not set');
      const body = { model, state, questions: Object.fromEntries(Object.entries(questions).map(([k, q]) => [k, toJev(q)])) };
      const send = () => f(`${baseUrl}/v1/systemone`, {
        method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
        body: JSON.stringify(body), ...(opts?.signal ? { signal: opts.signal } : {}),
      });
      let res = await send();
      if (res.status === 429) {
        // One retry, honouring retry-after but never waiting longer than the caller's budget allows.
        const wait = Math.min(2000, Math.max(100, Number(res.headers.get('retry-after') ?? 0.5) * 1000));
        await new Promise((r) => setTimeout(r, wait));
        res = await send();
      }
      if (!res.ok) throw new Error(`jev ${res.status}`);
      const json = (await res.json()) as { answers?: Record<string, JevAnswer> };
      return Object.fromEntries(Object.entries(questions).map(([k, q]) => [k, fromJev(q, json.answers?.[k])])) as Answers<Q>;
    },
  };
}
