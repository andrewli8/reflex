export type Question =
  | { type: 'boolean'; instructions: string; criteria?: { true: string; false: string } }
  | { type: 'choice'; instructions: string; criteria: Record<string, string> }
  | { type: 'score'; instructions: string; criteria: readonly string[] };

export type Answer =
  | { type: 'boolean'; p: number }
  | { type: 'choice'; choice: string; confidence: number; probabilities: Record<string, number> }
  | { type: 'score'; score: number; confidence: number; probabilities: number[] };

export type Answers<Q extends Record<string, Question>> = { [K in keyof Q]: Answer };

export interface Provider {
  readonly name: string;
  /** Serialized-state budget in estimated tokens. 0 means the provider is never called. */
  readonly maxStateTokens: number;
  decide<Q extends Record<string, Question>>(
    state: string,
    questions: Q,
    opts?: { signal?: AbortSignal },
  ): Promise<Answers<Q>>;
}

/** Deterministic-only mode: never called, signals stay null. */
export const noneProvider: Provider = {
  name: 'none',
  maxStateTokens: 0,
  decide: async () => {
    throw new Error('noneProvider.decide must not be called');
  },
};
