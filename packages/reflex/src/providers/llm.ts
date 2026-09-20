import type { Answer, Answers, Provider, Question } from '../provider.js';
import { readSecret } from '../session.js';

/**
 * LLM baseline critic: the same questions, answered by a generative model through one strict tool call.
 * Exists for the benchmark ("is a System-1 model better than a cheap LLM at this job?") and as a fallback
 * when no decision model is available. Uses the official Anthropic SDK, loaded lazily.
 */
export interface LlmOptions { model?: string; maxStateTokens?: number }

function schemaFor(questions: Record<string, Question>): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  for (const [k, q] of Object.entries(questions)) {
    if (q.type === 'boolean') properties[k] = { type: 'number', minimum: 0, maximum: 1, description: `P(true) for: ${q.instructions}` };
    else if (q.type === 'choice') properties[k] = { type: 'object', description: q.instructions, properties: Object.fromEntries(Object.keys(q.criteria).map((o) => [o, { type: 'number', minimum: 0, maximum: 1, description: q.criteria[o] }])), required: Object.keys(q.criteria), additionalProperties: false };
    else properties[k] = { type: 'array', description: `${q.instructions} Probability per level, lowest first: ${q.criteria.join(' < ')}`, items: { type: 'number' }, minItems: q.criteria.length, maxItems: q.criteria.length };
  }
  return { type: 'object', properties, required: Object.keys(questions), additionalProperties: false };
}

function normalize(q: Question, v: unknown): Answer {
  if (q.type === 'boolean') return { type: 'boolean', p: clamp(Number(v)) };
  if (q.type === 'choice') {
    const raw = (v && typeof v === 'object' ? (v as Record<string, number>) : {});
    const total = Object.values(raw).reduce((a, b) => a + (Number(b) || 0), 0) || 1;
    const probabilities = Object.fromEntries(Object.keys(q.criteria).map((o) => [o, clamp((Number(raw[o]) || 0) / total)]));
    const choice = Object.entries(probabilities).sort((a, b) => b[1] - a[1])[0]?.[0] ?? '';
    return { type: 'choice', choice, confidence: probabilities[choice] ?? 0, probabilities };
  }
  const arr = Array.isArray(v) ? v.map((x) => Number(x) || 0) : [];
  const total = arr.reduce((a, b) => a + b, 0) || 1;
  const probabilities = q.criteria.map((_, i) => clamp((arr[i] ?? 0) / total));
  const score = probabilities.reduce((a, p, i) => a + p * i, 0);
  return { type: 'score', score, confidence: Math.max(...probabilities, 0), probabilities };
}
const clamp = (n: number): number => (Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0.5);

export function llmProvider(o: LlmOptions = {}): Provider {
  const model = o.model ?? process.env['REFLEX_LLM_MODEL'] ?? 'claude-haiku-4-5';
  return {
    name: 'llm',
    maxStateTokens: o.maxStateTokens ?? 8000,
    async decide<Q extends Record<string, Question>>(state: string, questions: Q, opts?: { signal?: AbortSignal }): Promise<Answers<Q>> {
      const { default: Anthropic } = await import('@anthropic-ai/sdk');
      const apiKey = readSecret('ANTHROPIC_API_KEY');
      const client = new Anthropic(apiKey ? { apiKey } : {});
      const res = await client.messages.create({
        model, max_tokens: 512,
        system: 'You are a fast critic inside an agent tool loop. Answer every question with a calibrated probability. Do not explain.',
        tools: [{ name: 'answer', description: 'Report a probability for each question.', strict: true, input_schema: schemaFor(questions) as never }],
        tool_choice: { type: 'tool', name: 'answer' },
        messages: [{ role: 'user', content: state }],
      }, opts?.signal ? { signal: opts.signal } : undefined);
      const tool = res.content.find((b) => b.type === 'tool_use');
      const input = (tool && tool.type === 'tool_use' ? tool.input : {}) as Record<string, unknown>;
      return Object.fromEntries(Object.entries(questions).map(([k, q]) => [k, normalize(q, input[k])])) as Answers<Q>;
    },
  };
}
