import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { classify } from './classify.js';
import { defaultConfig, type ReflexConfig } from './config.js';
import { detectFlags, type Flags } from './detect.js';
import { capMode, postPolicy, prePolicy, type Applied, type Decision, type HostAction, type PolicyKind, type PostDecision as PostPolicyDecision, type PostSignals, type PreSignals } from './policy.js';
import { noneProvider, type Answer, type Provider, type Question } from './provider.js';
import { postQuestions, questionsFor, QUESTION_SET_ID } from './questions.js';
import { estimateTokens, extractConstraints, makeAction, serialize, sha, type Action, type ControlState } from './state.js';
import { identifiers } from './usefulness.js';

export interface ToolCall { toolUseId: string; tool: string; args: Record<string, unknown>; description?: string }
export interface ToolResult { output: string; error?: boolean }

export interface ReflexEvent {
  ts: number; step: number; toolUseId: string; tool: string; class: string; summary: string;
  phase: 'pre' | 'post' | 'permission' | 'meta'; policy: PolicyKind | PostPolicyDecision['kind']; applied: Applied | PostPolicyDecision['kind'];
  /** Pre events carry the normalized action so a session log can be folded back into state. */
  action?: Action; outcome?: Action['outcome']; resultDigest?: string; resultHash?: string; goal?: string;
  /** Post events: identifiers that first appeared in this result (capped). Pre events: steps whose results this call referenced. */
  novel?: string[]; refs?: number[];
  /** User-facing message for hosts that support one (Claude Code `systemMessage`). */
  userMessage?: string;
  reason?: string; flags?: Flags; signals?: Record<string, number> | null; forced?: boolean;
  suppressed?: 'neverIntervene' | 'rate'; patternAsk?: string; source: 'deterministic' | 'model' | 'fallback';
  providerMs?: number; cached?: boolean; bytesIn?: number; bytesOut?: number; questionSet?: string;
}

export interface PreDecision { policy: Decision; host: HostAction; event: ReflexEvent }
export interface PostResult { kind: PostPolicyDecision['kind']; replacement?: string; reason?: string; userMessage?: string; event: ReflexEvent }

export interface ReflexOptions {
  cwd: string;
  config?: Partial<ReflexConfig>;
  provider?: Provider;
  goal?: string;
  constraints?: string[];
  plan?: string;
  /** Prior events for this session (from session.ts); actions and counters are folded from them. */
  history?: ReflexEvent[];
  log?: (e: ReflexEvent) => void;
  now?: () => number;
  /** Directory for untrimmed originals. Omit to skip archiving (tests, replay). */
  archiveDir?: string;
  /** Latest user prompt, if the host can supply it; constraints are extracted from it too. */
  latestPrompt?: string;
  /** Directory for the cross-process decision cache. Omit for in-memory only (tests, replay). */
  cacheDir?: string;
}

const PROTECTED_EXT = /\.(ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|kt|rb|php|c|cc|cpp|h|hpp|cs|swift|sql|json|ya?ml|toml|xml|html|css|scss|md)$/i;
const STACK_RE = /^\s+at .+\(.+:\d+:\d+\)/m;
const OVERRIDE = 'reflex:force';
const CACHE_TTL_MS = 120_000;
const MAX_JSON_PROBE_BYTES = 256 * 1024;
const RESULT_FLAG_KEYS = ['file_path', 'path', 'notebook_path'] as const;

/** Framework-neutral critic. One instance per (session, agent). State is whatever `actions` the caller hands in; see session.ts for persistence. */
export class Reflex {
  readonly config: ReflexConfig;
  readonly provider: Provider;
  private readonly cwd: string;
  private actions: Action[];
  private events: ReflexEvent[] = [];
  private goal: string;
  private constraints: string[];
  private plan: string;
  private readonly cache = new Map<string, { at: number; answers: Record<string, Answer> }>();
  private readonly log: (e: ReflexEvent) => void;
  private readonly now: () => number;
  private readonly archiveDir: string | undefined;
  private readonly cacheDir: string | undefined;
  private latestPrompt: string;
  /** Identifiers already in context (goal, prompts, prior results), used to compute each result's novel set. */
  private seen = new Set<string>();
  /** step -> novel identifiers of that step's result, for reference detection on later calls. */
  private novelByStep = new Map<number, Set<string>>();
  private referenced = new Set<number>();

  constructor(o: ReflexOptions) {
    this.cwd = o.cwd;
    this.config = { ...defaultConfig, ...o.config, thresholds: { ...defaultConfig.thresholds, ...o.config?.thresholds }, trim: { ...defaultConfig.trim, ...o.config?.trim }, drop: { ...defaultConfig.drop, ...o.config?.drop } };
    this.provider = o.provider ?? noneProvider;
    this.goal = o.goal ?? '';
    this.constraints = o.constraints ?? extractConstraints(this.goal);
    this.plan = o.plan ?? '';
    const folded = foldEvents(o.history ?? []);
    this.actions = folded.actions;
    this.events = folded.events;
    for (const e of folded.events) {
      if (e.phase === 'post' && e.novel) this.novelByStep.set(e.step, new Set(e.novel));
      if (e.phase === 'pre' && e.refs) for (const r of e.refs) this.referenced.add(r);
    }
    for (const set of this.novelByStep.values()) for (const t of set) this.seen.add(t);
    if (!o.goal && folded.goal) this.setGoal(folded.goal);
    this.log = o.log ?? (() => {});
    this.now = o.now ?? Date.now;
    this.archiveDir = o.archiveDir;
    this.cacheDir = o.cacheDir;
    this.latestPrompt = o.latestPrompt ?? '';
    if (this.latestPrompt) this.constraints = [...new Set([...this.constraints, ...extractConstraints(this.latestPrompt)])].slice(0, 6);
    for (const t of identifiers(`${this.goal}\n${this.latestPrompt}`)) this.seen.add(t);
  }

  setGoal(goal: string): void { this.goal = goal; this.constraints = extractConstraints(goal); }
  setPlan(plan: string): void { this.plan = plan; }
  setLatestPrompt(p: string): void { this.latestPrompt = p; this.constraints = [...new Set([...extractConstraints(this.goal), ...extractConstraints(p)])].slice(0, 6); }
  get recentActions(): readonly Action[] { return this.actions; }
  get activeConstraints(): readonly string[] { return this.constraints; }

  async pre(call: ToolCall): Promise<PreDecision> {
    const step = this.actions.length + 1;
    const proposed = makeAction(call.tool, call.args, this.cwd, step);
    const cls = classify(call.tool, call.args, this.cwd);
    const forced = hasOverride(call);
    const refs = this.markReferences(`${JSON.stringify(call.args)}\n${this.plan}`);
    const base = { ts: this.now(), step, toolUseId: call.toolUseId, tool: call.tool, class: cls.class, summary: proposed.summary, phase: 'pre' as const };
    const finish = (policy: Decision, extra: Partial<ReflexEvent>, capped?: HostAction): PreDecision => {
      const host = capped ?? capMode(policy, this.config.mode, Boolean(cls.destructivePattern), this.config);
      const action: Action = { ...proposed, ...(host.applied === 'skip' || host.applied === 'replan' ? { outcome: 'skipped' as const } : host.applied === 'ask' ? { outcome: 'asked' as const } : {}) };
      const event: ReflexEvent = { ...base, policy: policy.kind, applied: host.applied, source: 'deterministic', action, ...(refs.length ? { refs } : {}), ...(policy.reason ? { reason: policy.reason } : {}), ...(forced ? { forced } : {}), ...extra };
      this.record(event, action);
      return { policy, host, event };
    };

    // 1. Destructive pattern: always ASK, before overrides and neverIntervene.
    if (cls.destructivePattern) return finish({ kind: 'ask', reason: `matches destructive pattern: ${cls.destructivePattern}` }, { patternAsk: cls.destructivePattern });
    // 2. Explicit override.
    if (forced) return finish({ kind: 'execute', reason: 'override' }, {});
    // 3. neverIntervene.
    if (this.neverIntervene(call, proposed)) return finish({ kind: 'execute' }, { suppressed: 'neverIntervene' });
    // 4. Deterministic waste checks.
    const flags = detectFlags(this.actions, proposed);
    let policy = prePolicy(flags, cls.readOnly, null, this.config);
    if (policy.kind === 'skip' && flags.exactDuplicate) {
      const earlier = [...this.actions].reverse().find((a) => a.signature === proposed.signature && a.resultDigest);
      if (earlier) policy = { ...policy, reason: `${policy.reason} at step ${earlier.step}; earlier result began "${earlier.resultDigest!.slice(0, 60)}"` };
    }
    let extra: Partial<ReflexEvent> = { flags };
    // 5. Provider, only when nothing short-circuited.
    if (policy.kind === 'execute' && this.provider.maxStateTokens > 0 && this.config.modelClasses.includes(cls.class)) {
      const questions = questionsFor(cls.readOnly, this.provider.maxStateTokens);
      const state = this.state(proposed);
      const r = await this.ask(state, questions, `${this.goal}|${this.constraints.join(';')}|${proposed.summary}|${QUESTION_SET_ID}`);
      policy = prePolicy(flags, cls.readOnly, r.signals as PreSignals | null, this.config);
      extra = { ...extra, ...r.meta, signals: r.signals };
    }
    // 6. Rate cap.
    const host = capMode(policy, this.config.mode, false, this.config);
    if (host.applied !== 'execute' && this.interventionsInLast5() >= this.config.maxInterventionsPer5Steps) {
      return finish(policy, { ...extra, suppressed: 'rate' }, { action: 'allow', applied: 'execute' });
    }
    return finish(policy, extra, host);
  }

  async post(call: ToolCall, result: ToolResult): Promise<PostResult> {
    const idx = this.actions.findIndex((a) => a.step === this.stepOf(call));
    const action = idx >= 0 ? this.actions[idx]! : makeAction(call.tool, call.args, this.cwd, this.actions.length + 1);
    const output = result.output ?? '';
    const bytes = Buffer.byteLength(output);
    const resultHash = sha(output);
    const flags = {
      error: Boolean(result.error) || /^(error|fatal|exception)\b/im.test(output.slice(0, 200)),
      protected: isProtected(call, output),
      identicalResult: this.actions.some((a, i) => i !== idx && a.resultHash === resultHash),
      repetitive: isRepetitive(output),
    };
    let decision = postPolicy(flags, null, bytes, this.config, action.class);
    let extra: Partial<ReflexEvent> = {};
    if (decision.kind === 'keep' && bytes >= this.config.trim.minBytes && !flags.protected && this.provider.maxStateTokens > 0) {
      const state = `${this.state(action)}\nRESULT (${bytes} bytes): ${digest(output, 600, 300)}`;
      const r = await this.ask(state, postQuestions, `post|${resultHash}|${QUESTION_SET_ID}`);
      decision = postPolicy(flags, r.signals as PostSignals | null, bytes, this.config, action.class);
      extra = { ...r.meta, signals: r.signals };
    }
    const archived = decision.kind === 'keep' || !this.archiveDir ? undefined : archive(this.archiveDir, call.toolUseId, output);
    const replacement = decision.kind === 'trim' ? trim(output, this.config, decision.reason, archived, action.class) : decision.kind === 'drop' ? `[reflex] Result omitted (${bytes} bytes): ${decision.reason}.${archived ? ` Full output archived at ${archived}.` : ''} Re-run with 'reflex:force' if needed.` : undefined;
    const novel: string[] = [];
    for (const t of identifiers(output)) { if (!this.seen.has(t) && novel.length < 60) novel.push(t); this.seen.add(t); }
    const step0 = idx >= 0 ? action.step : this.actions.length + 1;
    if (novel.length) this.novelByStep.set(step0, new Set(novel));
    const userMessage = this.contextGauge();
    const updated: Action = {
      ...action,
      outcome: flags.error ? 'error' : decision.kind === 'keep' ? 'ok' : 'trimmed',
      resultDigest: digest(output, 80, 0),
      resultHash,
    };
    const event: ReflexEvent = {
      ts: this.now(), step: updated.step, toolUseId: call.toolUseId, tool: call.tool, class: updated.class, summary: updated.summary,
      phase: 'post', policy: decision.kind, applied: decision.kind, source: extra.source ?? 'deterministic', bytesIn: bytes,
      bytesOut: replacement ? Buffer.byteLength(replacement) : bytes, resultHash, ...(novel.length ? { novel } : {}), ...(userMessage ? { userMessage } : {}), ...(updated.outcome ? { outcome: updated.outcome } : {}), ...(updated.resultDigest ? { resultDigest: updated.resultDigest } : {}),
      ...(decision.reason ? { reason: decision.reason } : {}), ...extra,
    };
    this.actions = idx >= 0 ? this.actions.map((a, i) => (i === idx ? updated : a)) : [...this.actions, updated];
    this.events = [...this.events, event];
    this.log(event);
    return { kind: decision.kind, ...(replacement !== undefined ? { replacement } : {}), ...(decision.reason ? { reason: decision.reason } : {}), ...(userMessage ? { userMessage } : {}), event };
  }

  private state(proposed: Action): string {
    const s: ControlState = { goal: this.goal, constraints: this.constraints, plan: this.plan, recentActions: this.actions.slice(-8), proposedAction: proposed, step: proposed.step, cwd: this.cwd, ...(this.latestPrompt && this.latestPrompt !== this.goal ? { latestPrompt: this.latestPrompt } : {}) };
    return serialize(s, this.provider.maxStateTokens);
  }

  private async ask<Q extends Record<string, Question>>(state: string, questions: Q, keySrc: string): Promise<{ signals: Record<string, number> | null; meta: Partial<ReflexEvent> }> {
    const key = sha(keySrc);
    const hit = this.cache.get(key) ?? this.readCache(key);
    if (hit && this.now() - hit.at < CACHE_TTL_MS) return { signals: toSignals(hit.answers), meta: { source: 'model', cached: true, questionSet: QUESTION_SET_ID } };
    const t0 = this.now();
    try {
      const answers = await this.provider.decide(state, questions, { signal: AbortSignal.timeout(this.config.providerTimeoutMs) });
      const entry = { at: this.now(), answers };
      this.cache.set(key, entry);
      this.writeCache(key, entry);
      return { signals: toSignals(answers), meta: { source: 'model', providerMs: this.now() - t0, questionSet: QUESTION_SET_ID, cached: false } };
    } catch {
      return { signals: null, meta: { source: 'fallback', providerMs: this.now() - t0, questionSet: QUESTION_SET_ID } };
    }
  }

  /** Hooks are one process per call, so the cache lives on disk: one small JSON file per key, TTL-checked on read. */
  private readCache(key: string): { at: number; answers: Record<string, Answer> } | undefined {
    if (!this.cacheDir) return undefined;
    try { return JSON.parse(readFileSync(join(this.cacheDir, `${key}.json`), 'utf8')); } catch { return undefined; }
  }
  private writeCache(key: string, entry: { at: number; answers: Record<string, Answer> }): void {
    if (!this.cacheDir) return;
    try { mkdirSync(this.cacheDir, { recursive: true }); writeFileSync(join(this.cacheDir, `${key}.json`), JSON.stringify(entry)); } catch { /* cache is best-effort */ }
  }

  private neverIntervene(call: ToolCall, a: Action): boolean {
    const cmd = call.tool === 'Bash' ? String(call.args['command'] ?? '') : '';
    return this.config.neverIntervene.some((g) => g === call.tool || (cmd && cmd.startsWith(g)) || a.paths.some((p) => globMatch(g, p)));
  }

  private interventionsInLast5(): number {
    const cutoff = this.actions.length - 5;
    return this.events.filter((e) => e.phase === 'pre' && e.step > cutoff && (e.applied === 'skip' || e.applied === 'replan' || (e.applied === 'ask' && !e.patternAsk))).length;
  }

  private stepOf(call: ToolCall): number | undefined {
    return this.events.find((e) => e.phase === 'pre' && e.toolUseId === call.toolUseId)?.step;
  }

  /** Which earlier results does this text reference? Marks them and returns their steps. */
  private markReferences(text: string): number[] {
    const ids = identifiers(text);
    const hit: number[] = [];
    for (const [step, novel] of this.novelByStep) {
      if (this.referenced.has(step)) continue;
      for (const t of ids) if (novel.has(t)) { this.referenced.add(step); hit.push(step); break; }
    }
    return hit;
  }

  /** Tool-use ids of results at least `minAge` steps old that no later call has referenced. */
  unreferenced(minAge = 5): Set<string> {
    const out = new Set<string>();
    const cutoff = this.actions.length - minAge;
    for (const e of this.events) if (e.phase === 'post' && e.step <= cutoff && !this.referenced.has(e.step) && e.toolUseId) out.add(e.toolUseId);
    return out;
  }

  /** Bytes admitted by results no later call has referenced yet. */
  deadWeight(): { bytes: number; results: number; total: number } {
    let bytes = 0; let results = 0; let total = 0;
    for (const e of this.events) {
      if (e.phase !== 'post') continue;
      const b = e.bytesOut ?? e.bytesIn ?? 0; total += b;
      if (!this.referenced.has(e.step) && e.step < this.actions.length - 3) { bytes += b; results++; }
    }
    return { bytes, results, total };
  }

  /** Rate-limited user-facing nudge when unreferenced tool output piles up. */
  private contextGauge(): string | undefined {
    const g = this.config.gauge;
    if (!g.enabled) return undefined;
    const lastAt = [...this.events].reverse().find((e) => e.userMessage)?.step ?? -Infinity;
    if (this.actions.length - lastAt < g.everySteps) return undefined;
    const d = this.deadWeight();
    if (d.bytes < g.minBytes) return undefined;
    return `[reflex] ${Math.round(d.bytes / 1024)} KB of tool output from ${d.results} earlier results has not been referenced since it was read (${Math.round((100 * d.bytes) / Math.max(1, d.total))}% of tool output in context). /compact when convenient; Reflex will restate what was verified.`;
  }

  /** Compact ledger of what this session established: for re-injection after compaction or resume. */
  ledger(): string {
    const lines: string[] = [];
    if (this.goal) lines.push(`GOAL: ${this.goal.slice(0, 300)}`);
    if (this.constraints.length) lines.push(`CONSTRAINTS: ${this.constraints.join('; ')}`);
    const used = (a: Action) => (this.referenced.has(a.step) ? 'used' : 'unused');
    const rel = (s: string) => s.split(this.cwd + '/').join('');
    const reads = this.actions.filter((a) => a.readOnly && a.outcome === 'ok').slice(-40);
    if (reads.length) lines.push(`READ (${reads.length}): ${reads.map((a) => `${rel(a.summary.replace(/^\w+ /, ''))} [${used(a)}]`).join('; ').slice(0, 1200)}`);
    const edits = this.actions.filter((a) => a.class === 'write' && a.outcome === 'ok');
    if (edits.length) lines.push(`EDITED (${edits.length}): ${[...new Set(edits.map((a) => rel(a.summary.replace(/^\w+ /, ''))))].join(', ').slice(0, 600)}`);
    const cmds = this.actions.filter((a) => (a.class === 'exec' || a.class === 'vcs' || a.class === 'db') && a.outcome).slice(-15);
    if (cmds.length) lines.push(`COMMANDS: ${cmds.map((a) => `${a.summary.replace(/^Bash /, '').slice(0, 60)} → ${a.outcome}${a.resultDigest ? ` "${a.resultDigest.slice(0, 40)}"` : ''}`).join(' | ').slice(0, 1500)}`);
    const asked = this.events.filter((e) => e.phase === 'pre' && e.applied === 'ask');
    if (asked.length) lines.push(`ASKED: ${asked.map((e) => `${e.summary.slice(0, 50)} (${e.reason ?? ''})`).join('; ').slice(0, 400)}`);
    return lines.join('\n');
  }

  /** Record a host-side event that carries no decision (permission prompt shown, tool failed). */
  note(call: ToolCall, phase: 'permission' | 'post', outcome?: Action['outcome']): ReflexEvent {
    const step = this.stepOf(call) ?? this.actions.length;
    const event: ReflexEvent = { ts: this.now(), step, toolUseId: call.toolUseId, tool: call.tool, class: '', summary: '', phase, policy: 'keep', applied: 'keep', source: 'deterministic', ...(outcome ? { outcome } : {}) };
    if (outcome) this.actions = this.actions.map((a) => (a.step === step ? { ...a, outcome } : a));
    this.events = [...this.events, event];
    this.log(event);
    return event;
  }

  private record(event: ReflexEvent, action: Action): void {
    this.actions = [...this.actions, action];
    this.events = [...this.events, event];
    this.log(event);
  }
}

/** Rebuild actions from a session's event log. Pre events add an action; post and failure events update its outcome. */
export function foldEvents(events: ReflexEvent[]): { actions: Action[]; events: ReflexEvent[]; goal?: string } {
  const actions: Action[] = [];
  let goal: string | undefined;
  for (const e of events) {
    if (e.phase === 'meta') { if (e.goal && e.summary !== 'prompt') goal = e.goal; continue; }
    if (e.phase === 'pre' && e.action) { actions.push(e.action); continue; }
    if (e.outcome || e.resultHash) {
      const i = actions.findIndex((a) => a.step === e.step);
      if (i >= 0) actions[i] = { ...actions[i]!, ...(e.outcome ? { outcome: e.outcome } : {}), ...(e.resultDigest ? { resultDigest: e.resultDigest } : {}), ...(e.resultHash ? { resultHash: e.resultHash } : {}) };
    }
  }
  return { actions, events, ...(goal ? { goal } : {}) };
}

function hasOverride(call: ToolCall): boolean {
  if (call.description?.includes(OVERRIDE)) return true;
  return Object.values(call.args).some((v) => typeof v === 'string' && v.includes(OVERRIDE));
}

function isProtected(call: ToolCall, output: string): boolean {
  const p = RESULT_FLAG_KEYS.map((k) => call.args[k]).find((v): v is string => typeof v === 'string');
  if (p && PROTECTED_EXT.test(p)) return true;
  if (STACK_RE.test(output)) return true;
  const head = output.trimStart().slice(0, 1);
  if ((head === '{' || head === '[') && output.length <= MAX_JSON_PROBE_BYTES) { try { JSON.parse(output); return true; } catch { /* not json */ } }
  return false;
}

/** Progress bars, package lists, repeated status lines: many lines that differ only in numbers or share a prefix. */
export function isRepetitive(output: string): boolean {
  const lines = output.split('\n').map((l) => l.trim()).filter(Boolean);
  if (lines.length < 6) return false;
  const shapes = new Set(lines.map((l) => l.replace(/[0-9]+/g, '#').replace(/\s+/g, ' ').slice(0, 24)));
  return shapes.size / lines.length < 0.5;
}

function digest(s: string, head: number, tail: number): string {
  const one = s.replace(/\s+/g, ' ').trim();
  if (one.length <= head + tail) return one;
  return tail > 0 ? `${one.slice(0, head)} … ${one.slice(-tail)}` : one.slice(0, head);
}

const ERROR_LINE = /(error|fail|exception|traceback|panic|fatal|assert|denied|refused|timed? ?out|✗|✘)/i;
const MAX_KEPT_LINES = 40;

/** Head + tail, plus up to 40 error-looking lines from the middle so a failure in a long log is never trimmed away. */
export function trim(output: string, cfg: ReflexConfig, reason?: string, archivePath?: string, toolClass = 'read'): string {
  const small = toolClass === 'exec' && output.length < cfg.trim.minBytes;
  const head = small ? cfg.trim.execHead : cfg.trim.head;
  const tail = small ? cfg.trim.execTail : cfg.trim.tail;
  if (output.length <= head + tail) return output;
  const middle = output.slice(head, output.length - tail);
  const kept = middle.split('\n').filter((l) => ERROR_LINE.test(l)).slice(0, MAX_KEPT_LINES);
  const lines = output.split('\n').length;
  const where = archivePath ? ` Full output archived at ${archivePath}.` : '';
  const keptBlock = kept.length ? `\n[reflex] ${kept.length} error-looking lines kept from the trimmed middle:\n${kept.join('\n')}\n` : '\n';
  return `${output.slice(0, head)}\n[reflex] trimmed ${lines} lines (${output.length} chars)${reason ? `: ${reason}` : ''}.${where} Re-run with 'reflex:force' to see everything.${keptBlock}${output.slice(-tail)}`;
}

/** Write the untrimmed output next to the session logs. Returns the path, or undefined if the write failed. */
function archive(dir: string, toolUseId: string, output: string): string | undefined {
  try {
    mkdirSync(dir, { recursive: true });
    const path = join(dir, `${(toolUseId || 'result').replace(/[^A-Za-z0-9_-]/g, '_')}-${Date.now()}.txt`);
    writeFileSync(path, output);
    return path;
  } catch { return undefined; }
}

function toSignals(answers: Record<string, Answer>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [k, a] of Object.entries(answers)) {
    out[k] = a.type === 'boolean' ? a.p : a.type === 'score' ? (a.probabilities.length > 1 ? a.score / (a.probabilities.length - 1) : a.score) : a.confidence;
  }
  return out;
}

function globMatch(glob: string, path: string): boolean {
  if (!glob.includes('*')) return path === glob || path.endsWith('/' + glob);
  const re = new RegExp('^' + glob.split('**').map((s) => s.split('*').map(escapeRe).join('[^/]*')).join('.*') + '$');
  return re.test(path);
}
const escapeRe = (s: string) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&');

export { estimateTokens };
export const hashOf = (s: string): string => createHash('sha256').update(s).digest('hex');
