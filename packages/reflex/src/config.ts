export type Mode = 'shadow' | 'nudge' | 'enforce';
export type Level = 'off' | 'watch' | 'nudge' | 'ask' | 'auto' | 'ultra';
export const LEVELS: Level[] = ['off', 'watch', 'nudge', 'ask', 'auto', 'ultra'];

export interface ReflexConfig {
  /** One knob that sets the rest. Explicit keys in the config file still override the preset. */
  level: Level;
  mode: Mode;
  provider?: string;
  /** Unattended levels: a call that would ask goes to deny with the reason instead, so the agent routes around it. */
  askBecomesDeny: boolean;
  /** Let the decision model judge destructive-pattern hits in context: clearly in scope becomes a note instead of a prompt. */
  judgePatterns: boolean;
  /** Ask the model about reads too (redundant/relevant). Measured at coin-flip quality; off outside ultra. */
  modelOnReads: boolean;
  /** AI SDK only: let a decision model pick a small or large model per step. */
  routing: { enabled: boolean };
  collapse: { after: number; checkpointEvery: number };
  thresholds: {
    outOfScopeAsk: number;
    outOfScopeReplan: number;
    destructive: number;
    irreversible: number;
    redundant: number;
    redundantNear: number;
    relevantTrim: number;
    /** requested + needed probability at or above this: a destructive-pattern hit is treated as intended and only noted. */
    patternIntended: number;
  };
  /** Tool names, path globs or command prefixes that are never nudged, skipped or replanned. Destructive-pattern ASK still applies. */
  neverIntervene: string[];
  maxInterventionsPer5Steps: number;
  /** In nudge mode, escalate model-detected risk to ASK instead of a note. */
  askOnModelRisk: boolean;
  trim: { enabled: boolean; minBytes: number; maxBytes: number; head: number; tail: number; execMinBytes: number; execHead: number; execTail: number };
  drop: { enabled: boolean };
  providerTimeoutMs: number;
  /** Tool classes that reach the decision model. Narrow this to cut per-call latency (e.g. ['write','vcs','db']). */
  modelClasses: string[];
  /** User-facing context gauge: warn when this many bytes of admitted output sit unreferenced; at most once per N steps. */
  gauge: { enabled: boolean; minBytes: number; everySteps: number };
  /** Re-inject the session ledger after compaction and on resume. */
  ledger: { enabled: boolean };
}

export const defaultConfig: ReflexConfig = {
  level: 'nudge',
  mode: 'nudge',
  askBecomesDeny: false,
  judgePatterns: false,
  modelOnReads: false,
  routing: { enabled: false },
  collapse: { after: 5, checkpointEvery: 10 },
  thresholds: {
    outOfScopeAsk: 0.85,
    outOfScopeReplan: 0.9,
    destructive: 0.9,
    irreversible: 0.9,
    redundant: 0.9,
    redundantNear: 0.7,
    relevantTrim: 0.3,
    patternIntended: 0.6,
  },
  neverIntervene: [],
  maxInterventionsPer5Steps: 2,
  askOnModelRisk: false,
  trim: { enabled: true, minBytes: 2000, maxBytes: 12000, head: 1500, tail: 500, execMinBytes: 600, execHead: 300, execTail: 150 },
  drop: { enabled: false },
  providerTimeoutMs: 1500, // Laya on a laptop CPU answers in 0.6–1.2 s; the hook's own timeout is 3 s
  modelClasses: ['read', 'search', 'network', 'write', 'exec', 'vcs', 'db'],
  gauge: { enabled: true, minBytes: 40 * 1024, everySteps: 30 },
  ledger: { enabled: true },
};

/** Presets. Each is a partial over defaultConfig; the caller overlays explicit keys afterwards. */
export const LEVEL_PRESETS: Record<Level, Partial<ReflexConfig>> = {
  off:   { mode: 'shadow', provider: 'none', trim: { ...defaultConfig.trim, enabled: false }, gauge: { ...defaultConfig.gauge, enabled: false }, ledger: { enabled: false } },
  watch: { mode: 'shadow', provider: 'none', trim: { ...defaultConfig.trim, enabled: false } },
  nudge: { mode: 'nudge', provider: 'none' },
  ask:   { mode: 'enforce', provider: 'jev', judgePatterns: true },
  auto:  { mode: 'enforce', provider: 'jev', askBecomesDeny: true, judgePatterns: true, trim: { ...defaultConfig.trim, minBytes: 1200 }, collapse: { after: 3, checkpointEvery: 5 } },
  ultra: { mode: 'enforce', provider: 'jev', askBecomesDeny: true, judgePatterns: true, modelOnReads: true, trim: { ...defaultConfig.trim, minBytes: 600, execMinBytes: 400 }, collapse: { after: 3, checkpointEvery: 5 }, routing: { enabled: true }, maxInterventionsPer5Steps: 4 },
};

export function applyLevel(level: Level): ReflexConfig {
  return { ...defaultConfig, ...LEVEL_PRESETS[level], level };
}
