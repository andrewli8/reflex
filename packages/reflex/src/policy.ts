import type { ReflexConfig, Mode } from './config.js';
import type { Flags } from './detect.js';

export type PolicyKind = 'execute' | 'skip' | 'ask' | 'replan' | 'warn';
export interface Decision { kind: PolicyKind; reason?: string }
export interface PreSignals { destructive?: number; irreversible?: number; outOfScope?: number; redundant?: number; relevant?: number }
export interface PostSignals { relevant?: number; novel?: number }
export interface PostFlags { error: boolean; protected: boolean; identicalResult: boolean; repetitive?: boolean }
export type PostKind = 'keep' | 'trim' | 'drop';
export interface PostDecision { kind: PostKind; reason?: string }

const d = (kind: PolicyKind, reason?: string): Decision => (reason ? { kind, reason } : { kind });

/** Pure policy after the deterministic short-circuits (override, destructive pattern, neverIntervene) have run. */
export function prePolicy(flags: Flags, readOnly: boolean, s: PreSignals | null, cfg: ReflexConfig): Decision {
  const t = cfg.thresholds;
  if (flags.cycle) return d('replan', 'repeating cycle of actions');
  if (readOnly && (flags.exactDuplicate || flags.stuck)) return d('skip', 'identical call already made');
  if (!readOnly && flags.polling) return d('warn', 'same command returned identical output twice; wait longer or change approach');
  if (s == null) return d('execute');
  if (!readOnly) {
    if ((s.outOfScope ?? 0) >= t.outOfScopeAsk) return d('ask', 'conflicts with the goal or a constraint');
    if ((s.destructive ?? 0) >= t.destructive || (s.irreversible ?? 0) >= t.irreversible) return d('ask', 'likely destructive or irreversible');
    return d('execute');
  }
  if ((s.outOfScope ?? 0) >= t.outOfScopeReplan) return d('replan', 'conflicts with the goal or a constraint');
  if ((s.redundant ?? 0) >= t.redundant) return d('skip', 'equivalent action already taken');
  if (flags.nearDuplicate && (s.redundant ?? 0) >= t.redundantNear) return d('skip', 'near-duplicate of a recent call');
  return d('execute');
}

export function postPolicy(f: PostFlags, s: PostSignals | null, bytes: number, cfg: ReflexConfig, toolClass = 'read'): PostDecision {
  const { maxBytes, enabled } = cfg.trim;
  // Command output is mostly acknowledgement noise re-sent on every later step; trim it from a lower floor.
  const minBytes = toolClass === 'exec' ? cfg.trim.execMinBytes : cfg.trim.minBytes;
  if (!enabled || f.error || bytes < minBytes) return { kind: 'keep' };
  // Small command output is trimmed only when it is repetitive (progress lines, package lists); dense output like help text stays.
  if (toolClass === 'exec' && bytes < cfg.trim.minBytes) return f.repetitive ? { kind: 'trim', reason: 'repetitive command output' } : { kind: 'keep' };
  if (f.identicalResult) return { kind: 'trim', reason: 'identical' }; // collapsed to one line naming the earlier step
  if (f.protected || s == null) return bytes > maxBytes ? { kind: 'trim', reason: 'large output' } : { kind: 'keep' };
  if (cfg.drop.enabled && (s.relevant ?? 1) <= 0.15 && (s.novel ?? 1) <= 0.15) return { kind: 'drop', reason: 'irrelevant and not new' };
  if ((s.relevant ?? 1) <= cfg.thresholds.relevantTrim || bytes > maxBytes) return { kind: 'trim', reason: 'low relevance or large output' };
  return { kind: 'keep' };
}

export type Applied = 'execute' | 'nudge' | 'skip' | 'ask' | 'replan';
export interface HostAction { action: 'allow' | 'deny' | 'ask'; applied: Applied; reason?: string; note?: string }

const NOTE = (r: string) => `[reflex] ${r}. Proceed if you disagree.`;

/** Mode caps what the policy output may become at the host. Pattern ASKs survive nudge; model ASKs only with askOnModelRisk. */
export function capMode(p: Decision, mode: Mode, patternAsk: boolean, cfg: ReflexConfig): HostAction {
  const reason = p.reason ?? p.kind;
  if (p.kind === 'execute' || mode === 'shadow') return { action: 'allow', applied: 'execute' };
  if (p.kind === 'warn') return { action: 'allow', applied: 'nudge', note: NOTE(reason) }; // never denies, in any mode
  if (p.kind === 'ask') {
    if (cfg.askBecomesDeny) return { action: 'deny', applied: 'ask', reason: `[reflex] ${reason}. Not executed (unattended mode); find another way or ask the user.` };
    if (patternAsk || mode === 'enforce' || cfg.askOnModelRisk) return { action: 'ask', applied: 'ask', reason: `[reflex] ${reason}` };
    return { action: 'allow', applied: 'nudge', note: NOTE(reason) };
  }
  if (mode === 'nudge') return { action: 'allow', applied: 'nudge', note: NOTE(reason) };
  const tail = p.kind === 'skip' ? " Reuse the earlier result, or re-run with 'reflex:force' in the description." : ' Restate the plan against the goal and constraints in one paragraph before continuing.';
  return { action: 'deny', applied: p.kind, reason: `[reflex] ${reason}.${tail}` };
}
