import { closeSync, openSync, readSync, statSync } from 'node:fs';
import { extractConstraints } from './state.js';

interface Line { type?: string; isMeta?: boolean; isSidechain?: boolean; cwd?: string; message?: { role?: string; content?: unknown } }

const SKIP_PREFIX = ['<command-name>', '<local-command-', '<system-reminder>', '<command-message>', '<task-notification>', '[Request interrupted', '<bash-input>', '<bash-stdout>'];

function text(content: unknown): string | undefined {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const t = content.filter((b): b is { type: string; text: string } => !!b && typeof b === 'object' && (b as { type?: string }).type === 'text' && typeof (b as { text?: unknown }).text === 'string').map((b) => b.text).join('\n');
    return t || undefined;
  }
  return undefined;
}

const isPrompt = (d: Line, t: string): boolean =>
  d.type === 'user' && !d.isMeta && !d.isSidechain && !SKIP_PREFIX.some((p) => t.startsWith(p));

function* lines(path: string, start = 0, maxBytes?: number): Generator<Line> {
  let fd: number;
  try { fd = openSync(path, 'r'); } catch { return; }
  try {
    const size = statSync(path).size;
    const from = maxBytes === undefined ? start : Math.max(start, size - maxBytes);
    const buf = Buffer.alloc(Math.max(0, size - from));
    readSync(fd, buf, 0, buf.length, from);
    let s = buf.toString('utf8');
    if (from > 0) s = s.slice(s.indexOf('\n') + 1);
    for (const l of s.split('\n')) { if (!l) continue; try { yield JSON.parse(l) as Line; } catch { /* skip */ } }
  } finally { closeSync(fd); }
}

/** First real user prompt plus the session cwd: scans from the top, stops at the first hit. Cache the result; never rescan. */
export function readGoal(path: string): { goal: string; constraints: string[]; cwd?: string } | undefined {
  let cwd: string | undefined;
  for (const d of lines(path)) {
    cwd ??= d.cwd;
    const t = text(d.message?.content)?.trim();
    if (t && isPrompt(d, t)) return { goal: t.slice(0, 600), constraints: extractConstraints(t), ...(cwd ? { cwd } : {}) };
  }
  return undefined;
}

/** Latest assistant text and latest real user prompt in the tail. The transcript lags the live conversation; both are advisory. */
export function readTailState(path: string, tailBytes = 64 * 1024): { plan: string; latestPrompt: string } {
  let plan = '';
  let latestPrompt = '';
  for (const d of lines(path, 0, tailBytes)) {
    const t = text(d.message?.content)?.trim();
    if (!t) continue;
    if (d.type === 'assistant') plan = t.slice(0, 300);
    else if (isPrompt(d, t)) latestPrompt = t.slice(0, 600);
  }
  return { plan, latestPrompt };
}

export function readPlan(path: string, tailBytes = 64 * 1024): string { return readTailState(path, tailBytes).plan; }
