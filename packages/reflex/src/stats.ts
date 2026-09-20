import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { ReflexEvent } from './critic.js';
import { readTail, sessionsDir } from './session.js';

export interface Stats {
  sessions: number; calls: number;
  applied: Record<string, number>; policy: Record<string, number>;
  source: Record<string, number>; path: Record<string, number>;
  providerMs: { p50: number; p95: number; n: number };
  bytesIn: number; bytesOut: number;
  overrides: number; suppressed: Record<string, number>;
  asks: { total: number; approved: number; denied: number; auto: number };
}

const pct = (xs: number[], p: number): number => (xs.length ? xs.slice().sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(p * xs.length))]! : 0);
const bump = (m: Record<string, number>, k: string) => { m[k] = (m[k] ?? 0) + 1; };

/** Fold event logs into counts. ASK outcome: PermissionRequest seen + no later post/failure = denied; none seen = auto-decided. */
export function computeStats(logs: ReflexEvent[][]): Stats {
  const s: Stats = { sessions: logs.length, calls: 0, applied: {}, policy: {}, source: {}, path: {}, providerMs: { p50: 0, p95: 0, n: 0 }, bytesIn: 0, bytesOut: 0, overrides: 0, suppressed: {}, asks: { total: 0, approved: 0, denied: 0, auto: 0 } };
  const ms: number[] = [];
  for (const events of logs) {
    const asked = new Set<string>(); const prompted = new Set<string>(); const finished = new Set<string>();
    for (const e of events) {
      if (e.phase === 'pre') {
        s.calls++; bump(s.applied, e.applied); bump(s.policy, e.policy); bump(s.source, e.source);
        if (e.forced) s.overrides++;
        if (e.suppressed) bump(s.suppressed, e.suppressed);
        if (typeof e.providerMs === 'number' && e.source === 'model' && !e.cached) ms.push(e.providerMs);
        if (e.applied === 'ask') asked.add(e.toolUseId);
      } else if (e.phase === 'post') {
        finished.add(e.toolUseId);
        s.bytesIn += e.bytesIn ?? 0; s.bytesOut += e.bytesOut ?? e.bytesIn ?? 0;
      } else if (e.phase === 'permission') prompted.add(e.toolUseId);
    }
    for (const id of asked) {
      s.asks.total++;
      if (!prompted.has(id)) s.asks.auto++;
      else if (finished.has(id)) s.asks.approved++;
      else s.asks.denied++;
    }
  }
  s.providerMs = { p50: pct(ms, 0.5), p95: pct(ms, 0.95), n: ms.length };
  return s;
}

export function loadAllLogs(dir = sessionsDir(), maxBytesPerLog = 4 * 1024 * 1024): ReflexEvent[][] {
  let files: string[] = [];
  try { files = readdirSync(dir).filter((f) => f.endsWith('.jsonl')); } catch { return []; }
  return files.map((f) => readTail(join(dir, f), maxBytesPerLog));
}

export function formatStats(s: Stats): string {
  const kb = (n: number) => `${(n / 1024).toFixed(0)} KB`;
  const rec = (m: Record<string, number>) => Object.entries(m).map(([k, v]) => `${k}=${v}`).join(' ') || '-';
  return [
    `sessions ${s.sessions}  calls ${s.calls}`,
    `applied   ${rec(s.applied)}`,
    `policy    ${rec(s.policy)}`,
    `source    ${rec(s.source)}   path ${rec(s.path)}`,
    `provider  p50 ${s.providerMs.p50} ms  p95 ${s.providerMs.p95} ms  (n=${s.providerMs.n})`,
    `output    ${kb(s.bytesIn)} in, ${kb(s.bytesOut)} admitted (${s.bytesIn ? Math.round(100 - (100 * s.bytesOut) / s.bytesIn) : 0}% trimmed)`,
    `overrides ${s.overrides}   suppressed ${rec(s.suppressed)}`,
    `asks      ${s.asks.total} (approved ${s.asks.approved}, denied ${s.asks.denied}, auto ${s.asks.auto})`,
  ].join('\n');
}
