import type { Action } from './state.js';

export interface Flags {
  exactDuplicate: boolean;
  nearDuplicate: boolean;
  cycle: boolean;
  stuck: boolean;
  /** Same mutating command twice in a row with identical, non-empty output: a polling loop. */
  polling: boolean;
}

export interface CycleOpts { maxLen: number; minRepeats: number; window: number }
export const defaultCycleOpts: CycleOpts = { maxLen: 5, minRepeats: 3, window: 25 };

/** Returns the cycle length if the tail of `sigs` is a block of that length repeated `minRepeats` times, else 0. */
export function findCycle(sigs: string[], o: CycleOpts = defaultCycleOpts): number {
  const s = sigs.slice(-o.window);
  for (let len = 1; len <= o.maxLen; len++) {
    const span = len * o.minRepeats;
    if (span > s.length) break;
    const tail = s.slice(-span);
    const block = tail.slice(0, len);
    if (tail.every((x, i) => x === block[i % len])) return len;
  }
  return 0;
}

const tokens = (a: Action): Set<string> => new Set(a.summary.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean));
function jaccard(a: Set<string>, b: Set<string>): number {
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  const union = a.size + b.size - inter;
  return union === 0 ? 1 : inter / union;
}

/**
 * Does mutation `m` invalidate an earlier result of `proposed`?
 * - proposed has paths: only a mutation touching one of them.
 * - proposed has no paths (repo-wide grep, ls, web search): any write/vcs/db mutation, or a Bash exec that names paths.
 * A pathless exec (`npm test`, `pgrep`) never clears file-read duplicates; that was the recall killer on replay.
 */
const mcpServer = (tool: string): string | undefined => (tool.startsWith('mcp__') ? tool.split('__')[1] : undefined);

const invalidates = (m: Action, proposed: Action): boolean => {
  if (proposed.paths.length > 0) return m.paths.some((p) => proposed.paths.includes(p));
  // A mutation on the same MCP server (browser click, API write) changes what a pathless read on that server returns.
  const srv = mcpServer(proposed.tool);
  if (srv && mcpServer(m.tool) === srv) return true;
  return m.class === 'write' || m.class === 'vcs' || m.class === 'db' || m.paths.length > 0;
};

export function detectFlags(recent: Action[], proposed: Action, o: CycleOpts = defaultCycleOpts): Flags {
  const window = recent.slice(-o.window);
  let exactDuplicate = false;
  for (let i = window.length - 1; i >= 0; i--) {
    const a = window[i]!;
    if (a.signature !== proposed.signature || (a.outcome !== 'ok' && a.outcome !== 'trimmed')) continue;
    if (a.resultDigest === '') break; // empty text result (image, binary): no evidence a re-read is redundant
    if (a.mtimeMs !== undefined && proposed.mtimeMs !== undefined && a.mtimeMs !== proposed.mtimeMs) break; // file changed outside the agent's own writes
    exactDuplicate = !window.slice(i + 1).some((m) => !m.readOnly && invalidates(m, proposed));
    break;
  }
  const pt = tokens(proposed);
  const nearDuplicate = !exactDuplicate && recent.slice(-8).some((a) =>
    a.tool === proposed.tool && a.signature !== proposed.signature && (a.outcome === 'ok' || a.outcome === 'trimmed') && jaccard(tokens(a), pt) >= 0.8);
  const sigs = [...window.map((a) => a.signature), proposed.signature];
  const cycle = findCycle(sigs, o) >= 2; // length-1 repeats are `stuck`, handled as a skip on reads
  const stuck = window.length >= 2 && window.slice(-2).every((a) => a.signature === proposed.signature);
  const last2 = window.slice(-2);
  const polling = last2.length === 2 && last2.every((a) => a.signature === proposed.signature && !!a.resultHash && a.resultDigest !== '') && last2[0]!.resultHash === last2[1]!.resultHash;
  return { exactDuplicate, nearDuplicate, cycle, stuck, polling };
}
