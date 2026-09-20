import { Laya } from '@receptron/laya';
import type { Answer, Answers, Provider, Question } from 'agent-reflex';

type LayaQuestion = { type: 'noul' | 'choice' | 'score'; instructions: string; criteria?: unknown };
type LayaAnswer = { noul?: number; choice?: string; score?: number; confidence?: number; probabilities?: Record<string, number> | number[] };

/** Laya's English checkpoint sees 512 tokens; leave room for the question text. */
export const LAYA_STATE_TOKENS = 400;

function toLaya(q: Question): LayaQuestion {
  if (q.type === 'boolean') return { type: 'noul', instructions: q.instructions, ...(q.criteria ? { criteria: q.criteria } : {}) };
  return { type: q.type, instructions: q.instructions, criteria: q.criteria };
}

function fromLaya(q: Question, a: LayaAnswer): Answer {
  if (q.type === 'boolean') return { type: 'boolean', p: a.noul ?? 0.5 };
  if (q.type === 'choice') {
    const probabilities = (a.probabilities as Record<string, number>) ?? {};
    const choice = a.choice ?? Object.keys(probabilities)[0] ?? '';
    return { type: 'choice', choice, confidence: a.confidence ?? probabilities[choice] ?? 0, probabilities };
  }
  const probs = Array.isArray(a.probabilities) ? a.probabilities : Object.values(a.probabilities ?? {});
  return { type: 'score', score: a.score ?? 0, confidence: a.confidence ?? 0, probabilities: probs };
}

/** Load Laya once and expose it as a Reflex provider. Run this inside `reflex serve`, not inside a hook process. */
export async function layaProvider(opts: Parameters<typeof Laya.load>[0] = {}): Promise<Provider & { close(): Promise<void> }> {
  const laya = await Laya.load(opts);
  return {
    name: 'laya',
    maxStateTokens: LAYA_STATE_TOKENS,
    async decide<Q extends Record<string, Question>>(state: string, questions: Q): Promise<Answers<Q>> {
      const lq = Object.fromEntries(Object.entries(questions).map(([k, q]) => [k, toLaya(q)]));
      const r = (await laya.systemOne(state, lq as never)) as { answers: Record<string, LayaAnswer> };
      return Object.fromEntries(Object.entries(questions).map(([k, q]) => [k, fromLaya(q, r.answers[k] ?? {})])) as Answers<Q>;
    },
    close: () => laya.close(),
  };
}
