import type { Question } from './provider.js';

/** Question text is versioned; the id is recorded on every event so threshold tuning can be tied to wording. */
export const QUESTION_SET_ID = 'q4';

const outOfScope: Question = { type: 'boolean', instructions: 'Does the PROPOSED action conflict with the GOAL or with any listed CONSTRAINT?' };
const destructive: Question = { type: 'boolean', instructions: 'Would the PROPOSED action delete, overwrite, or make unrecoverable something that was not created during this session?' };
const irreversible: Question = { type: 'boolean', instructions: 'Would the effect of the PROPOSED action be impossible to undo in one step?' };
const relevant: Question = { type: 'boolean', instructions: 'Will the result of the PROPOSED read matter for completing the GOAL, given the PLAN and what RECENT already covered?' };
const redundant: Question = { type: 'boolean', instructions: 'Does RECENT already contain an equivalent action whose result is still valid, so the PROPOSED action would add nothing new?' };

/** Full sets for providers with room (Jev: three questions cost the same round trip as one). */
export const mutatingQuestions = { outOfScope, destructive, irreversible } as const satisfies Record<string, Question>;
export const readQuestions = { redundant, relevant, outOfScope } as const satisfies Record<string, Question>;

/**
 * One question per call for small local models. Laya on a laptop CPU costs ~285 ms per question and scales
 * linearly, and on the 400-token state only `redundant` separated in probes (0.71 reread vs 0.33 new file).
 */
export const mutatingQuestionsSmall = { outOfScope } as const satisfies Record<string, Question>;
export const readQuestionsSmall = { redundant } as const satisfies Record<string, Question>;

/** Providers under this state budget get the single-question sets. */
export const SMALL_PROVIDER_TOKENS = 1000;

export function questionsFor(readOnly: boolean, maxStateTokens: number): Record<string, Question> {
  const small = maxStateTokens < SMALL_PROVIDER_TOKENS;
  if (readOnly) return small ? readQuestionsSmall : readQuestions;
  return small ? mutatingQuestionsSmall : mutatingQuestions;
}

export const postQuestions = {
  relevant: { type: 'boolean', instructions: 'Is the RESULT relevant to the GOAL and the PLAN?' },
  novel: { type: 'boolean', instructions: 'Does the RESULT contain information that RECENT does not already contain?' },
} as const satisfies Record<string, Question>;
