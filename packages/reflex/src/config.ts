export type Mode = 'shadow' | 'nudge' | 'enforce';

export interface ReflexConfig {
  mode: Mode;
  thresholds: {
    outOfScopeAsk: number;
    outOfScopeReplan: number;
    destructive: number;
    irreversible: number;
    redundant: number;
    redundantNear: number;
    relevantTrim: number;
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
  mode: 'nudge',
  thresholds: {
    outOfScopeAsk: 0.85,
    outOfScopeReplan: 0.9,
    destructive: 0.9,
    irreversible: 0.9,
    redundant: 0.9,
    redundantNear: 0.7,
    relevantTrim: 0.3,
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
