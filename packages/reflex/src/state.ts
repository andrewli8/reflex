import { createHash } from 'node:crypto';
import { isAbsolute, resolve } from 'node:path';
import { classify } from './classify.js';

export type ToolClass = 'read' | 'search' | 'network' | 'write' | 'exec' | 'vcs' | 'db';
export type Outcome = 'ok' | 'error' | 'skipped' | 'asked' | 'trimmed';

export interface Action {
  tool: string;
  class: ToolClass;
  readOnly: boolean;
  summary: string;
  signature: string;
  paths: string[];
  step: number;
  outcome?: Outcome;
  resultDigest?: string;
  resultHash?: string;
}

export interface ControlState {
  goal: string;
  constraints: string[];
  plan: string;
  recentActions: Action[];
  proposedAction: Action;
  step: number;
  cwd: string;
  /** Most recent user prompt when it differs from the goal; dropped first under budget pressure. */
  latestPrompt?: string;
}

const PATH_KEYS = new Set(['file_path', 'path', 'notebook_path', 'cwd', 'directory']);
const QUERY_KEYS = new Set(['pattern', 'query', 'q', 'glob']);
const IGNORED_KEYS = new Set(['description', 'reason', 'timeout', 'run_in_background']);
// Imperative constraints only: "Do not change X", "Never push", "Only edit app code", "Must keep the API stable".
// Descriptive uses ("agents do not only need reasoning", "this must be why") are excluded.
const CONSTRAINT_RE = /^(?:please\s+)?(?:do not|don't|never|always|only|avoid|must not|keep|without)\b|[,;]\s*(?:but\s+|and\s+|also\s+|then\s+)?(?:do not|don't|never)\b|\bmust (?:not|keep|stay|remain|use)\b|\b(?:and|but|also|please)\s+never\b/i;
// Descriptive prose, transcribed speech, code and shouting are not instructions.
const NOT_CONSTRAINT_RE = /\bnot only\b|\bdo not (?:only|need|have|know|think|seem|want)\b|`|—|\b(?:I|I've|I'm|we've|they|it'll|you know|unfortunately|because)\b.*\b(?:never|don't|do not)\b/i;
const SHOUTING_RE = /^[^a-z]*$/; // case-sensitive: no lowercase letter at all

/**
 * Strip secret-looking values before anything is logged, archived, summarised or sent to a provider.
 * Covers name=value pairs with sensitive names, bearer/basic auth headers, and well-known token prefixes.
 * Hashes and ordinary identifiers are left alone; false positives here cost nothing, misses cost a key.
 */
const SECRET_KV = /\b([\w.-]*(?:api[_-]?key|secret|token|passw(?:or)?d|auth(?:orization)?|private[_-]?key|access[_-]?key|client[_-]?secret|session[_-]?id|cookie)[\w.-]*)(\s*[=:]\s*)(["']?)([^\s"'&;,]{6,})\3/gi;
const SECRET_HEADER = /\b(bearer|basic|token)\s+([A-Za-z0-9._~+/=-]{16,})/gi;
const SECRET_TOKEN = /\b(?:sk-[A-Za-z0-9_-]{16,}|sk-ant-[A-Za-z0-9_-]{16,}|apikey_[A-Za-z0-9_]{16,}|ghp_[A-Za-z0-9]{20,}|gho_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[abpr]-[A-Za-z0-9-]{16,}|AIza[0-9A-Za-z_-]{30,}|AKIA[0-9A-Z]{16}|eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}|-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----)/g;
export function redact(text: string): string {
  return text
    .replace(SECRET_TOKEN, '[redacted]')
    .replace(SECRET_HEADER, (_m, kind: string) => `${kind} [redacted]`)
    .replace(SECRET_KV, (_m, name: string, sep: string) => `${name}${sep}[redacted]`);
}

export const sha = (s: string): string => createHash('sha256').update(s).digest('hex').slice(0, 16);
export const estimateTokens = (s: string): number => Math.ceil(s.length / 4);
const clip = (s: string, n: number): string => (s.length > n ? s.slice(0, n) : s);

export function normalizePath(p: string, cwd: string): string {
  if (p.startsWith('~')) return p;
  return isAbsolute(p) ? resolve(p) : resolve(cwd, p);
}

function bashPaths(command: string, cwd: string): string[] {
  return command
    .split(/\s+/)
    .filter((t) => /^[\w.~/-][\w.~/@-]*$/.test(t) && !t.startsWith('-') && (t.includes('/') || /\.\w+$/.test(t)))
    .map((t) => normalizePath(t, cwd));
}

/** Canonical argument string (sorted keys, resolved paths, collapsed whitespace) and the paths the call touches. */
export function canonicalArgs(tool: string, args: Record<string, unknown>, cwd: string): { canonical: string; paths: string[] } {
  const paths: string[] = [];
  const entries = Object.keys(args)
    .filter((k) => !IGNORED_KEYS.has(k))
    .sort()
    .map((k) => {
      let v = args[k];
      if (typeof v === 'string') {
        v = v.replace(/\s+/g, ' ').trim();
        if (PATH_KEYS.has(k)) { v = normalizePath(v as string, cwd); paths.push(v as string); }
        else if (QUERY_KEYS.has(k)) v = (v as string).toLowerCase();
        else if (tool === 'Bash' && k === 'command') paths.push(...bashPaths(v as string, cwd));
      }
      return [k, v];
    });
  return { canonical: JSON.stringify(entries), paths: [...new Set(paths)] };
}

const snippet = (v: unknown, n = 40): string => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, n) : '');

export function summarize(tool: string, args: Record<string, unknown>): string {
  const a = args as Record<string, string | undefined>;
  // Edits carry what changes, not only where: a decision model cannot judge "replace auth0 with clerk" from a path alone.
  const change = a['old_string'] !== undefined || a['new_string'] !== undefined
    ? ` "${snippet(a['old_string'])}" → "${snippet(a['new_string'])}"`
    : a['content'] !== undefined && tool !== 'Bash' ? ` "${snippet(a['content'], 60)}"` : a['patch'] !== undefined ? ` ${snippet(a['patch'], 80)}` : '';
  const body =
    tool === 'Bash' ? a['command'] :
    (tool === 'Edit' || tool === 'Write' || tool === 'MultiEdit' || tool === 'apply_patch') ? `${a['file_path'] ?? a['path'] ?? ''}${change}` :
    tool === 'Grep' ? `"${a['pattern']}" ${a['path'] ?? ''}` :
    a['file_path'] ?? a['path'] ?? a['pattern'] ?? a['query'] ?? a['url'] ?? a['prompt'] ??
    Object.values(args).find((v): v is string => typeof v === 'string') ?? '';
  return clip(redact(`${tool} ${(body ?? '').replace(/\s+/g, ' ').trim()}`.trim()), 160);
}

export function makeAction(tool: string, args: Record<string, unknown>, cwd: string, step: number): Action {
  const cls = classify(tool, args, cwd);
  const { canonical, paths } = canonicalArgs(tool, args, cwd);
  return { tool, class: cls.class, readOnly: cls.readOnly, summary: summarize(tool, args), signature: sha(`${tool}:${canonical}`), paths, step };
}

export function extractConstraints(goal: string): string[] {
  return goal
    .split(/(?<=[.!?;])\s+|\n+/)
    .map((s) => s.replace(/^[>#*\-\s]+/, '').trim())
    .filter((s) => s && s.length <= 240 && s.split(/\s+/).length >= 3 && CONSTRAINT_RE.test(s) && !NOT_CONSTRAINT_RE.test(s) && !SHOUTING_RE.test(s))
    .map((s) => clip(s, 200))
    .slice(0, 6);
}

function render(s: ControlState, actions: Action[], plan: string, goal: string, latest = ''): string {
  const recent = actions.map((a, i) => ` ${i + 1} ${a.summary}${a.outcome ? ` ${a.outcome}` : ''}${a.resultDigest ? ` "${a.resultDigest}"` : ''}`).join('\n');
  return [
    `GOAL: ${goal}`,
    latest ? `LATEST USER MESSAGE: ${latest}` : '',
    s.constraints.length ? `CONSTRAINTS: ${s.constraints.join('; ')}` : '',
    plan ? `PLAN: ${plan}` : '',
    actions.length ? `RECENT:\n${recent}` : 'RECENT: none',
    `PROPOSED [${s.proposedAction.class}]: ${s.proposedAction.summary}`,
  ].filter(Boolean).join('\n');
}

/** Serialize under a token budget. Drop order: oldest actions, then plan, then goal. Constraints and the proposed action are never dropped. */
export function serialize(state: ControlState, maxTokens: number): string {
  let actions = state.recentActions;
  let plan = clip(state.plan, 300);
  let goal = clip(state.goal, 600);
  let latest = clip(state.latestPrompt ?? '', 300);
  const r = () => render(state, actions, plan, goal, latest);
  let out = r();
  if (estimateTokens(out) > maxTokens && latest) { latest = ''; out = r(); }
  while (estimateTokens(out) > maxTokens && actions.length > 0) { actions = actions.slice(1); out = r(); }
  while (estimateTokens(out) > maxTokens && plan.length > 0) { plan = clip(plan, Math.floor(plan.length / 2)); if (plan.length < 40) plan = ''; out = r(); }
  while (estimateTokens(out) > maxTokens && goal.length > 80) { goal = clip(goal, Math.floor(goal.length / 2)); out = r(); }
  return out;
}
