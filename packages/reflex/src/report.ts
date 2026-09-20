import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { foldEvents, type ReflexEvent } from './critic.js';
import { readTail, sessionsDir } from './session.js';

export interface NearMiss { when: number; goal: string; summary: string; reason: string; outcome: 'approved' | 'denied' | 'auto' | 'shadow' }
export interface Report {
  days: number; sessions: number; calls: number;
  nearMisses: NearMiss[];
  pollingLoops: { goal: string; summary: string; count: number }[];
  deadWeight: { bytes: number; results: number; total: number };
  trimmedBytes: number; nudges: number;
  topUnused: { summary: string; bytes: number; count: number }[];
}

/** Everything a developer would want to see about the last N days of agent runs, from the session logs alone. */
export function buildReport(days = 30, dir = sessionsDir(), now = Date.now()): Report {
  const cutoff = now - days * 86_400_000;
  let files: string[] = [];
  try { files = readdirSync(dir).filter((f) => f.endsWith('.jsonl')).map((f) => join(dir, f)).filter((p) => { try { return statSync(p).mtimeMs >= cutoff; } catch { return false; } }); } catch { /* none */ }
  const r: Report = { days, sessions: 0, calls: 0, nearMisses: [], pollingLoops: [], deadWeight: { bytes: 0, results: 0, total: 0 }, trimmedBytes: 0, nudges: 0, topUnused: [] };
  const unused = new Map<string, { bytes: number; count: number }>();
  for (const path of files) {
    const events = readTail(path, 8 * 1024 * 1024);
    if (!events.some((e) => e.phase === 'pre')) continue;
    r.sessions++;
    const { goal = '' } = foldEvents(events);
    const asked = new Map<string, ReflexEvent>(); const prompted = new Set<string>(); const finished = new Set<string>();
    const referenced = new Set<number>(); const posts: ReflexEvent[] = []; const pres = new Map<number, ReflexEvent>();
    const polling = new Map<string, number>();
    for (const e of events) {
      if (e.phase === 'pre') {
        r.calls++; pres.set(e.step, e);
        if (e.policy === 'ask') asked.set(e.toolUseId, e); // what Reflex wanted; shadow/replay runs never applied it
        if (e.applied === 'nudge') r.nudges++;
        if (e.policy === 'warn') polling.set(e.summary, (polling.get(e.summary) ?? 0) + 1);
        for (const s of e.refs ?? []) referenced.add(s);
      } else if (e.phase === 'post') { posts.push(e); finished.add(e.toolUseId); }
      else if (e.phase === 'permission') prompted.add(e.toolUseId);
    }
    for (const [id, e] of asked) r.nearMisses.push({ when: e.ts, goal: goal.slice(0, 80), summary: e.summary.slice(0, 100), reason: e.reason ?? '', outcome: e.applied !== 'ask' ? 'shadow' : !prompted.has(id) ? 'auto' : finished.has(id) ? 'approved' : 'denied' });
    for (const [summary, count] of polling) r.pollingLoops.push({ goal: goal.slice(0, 60), summary: summary.slice(0, 80), count });
    const lastStep = Math.max(0, ...posts.map((p) => p.step));
    for (const p of posts) {
      const b = p.bytesOut ?? p.bytesIn ?? 0; r.deadWeight.total += b;
      r.trimmedBytes += Math.max(0, (p.bytesIn ?? 0) - b);
      if (!referenced.has(p.step) && p.step < lastStep - 3 && b > 0) {
        r.deadWeight.bytes += b; r.deadWeight.results++;
        const key = (pres.get(p.step)?.summary ?? p.summary).replace(/\d+/g, '#').slice(0, 60);
        const u = unused.get(key) ?? { bytes: 0, count: 0 }; unused.set(key, { bytes: u.bytes + b, count: u.count + 1 });
      }
    }
  }
  r.nearMisses.sort((a, b) => b.when - a.when);
  r.topUnused = [...unused.entries()].map(([summary, v]) => ({ summary, ...v })).sort((a, b) => b.bytes - a.bytes).slice(0, 8);
  return r;
}

export function formatReport30(r: Report): string {
  const kb = (n: number) => `${Math.round(n / 1024)} KB`;
  const pct = r.deadWeight.total ? Math.round((100 * r.deadWeight.bytes) / r.deadWeight.total) : 0;
  const out = [
    `Reflex report: last ${r.days} days, ${r.sessions} sessions, ${r.calls} tool calls`,
    '',
    `Near misses (destructive or out-of-scope calls Reflex would send to the permission prompt): ${r.nearMisses.length}`,
    ...r.nearMisses.slice(0, 12).map((m) => `  ${new Date(m.when).toISOString().slice(0, 10)}  ${m.outcome.padEnd(8)} ${m.summary}\n             ${m.reason}  [task: ${m.goal}]`),
    '',
    `Polling loops flagged: ${r.pollingLoops.length}`,
    ...r.pollingLoops.slice(0, 6).map((p) => `  ${p.count}x  ${p.summary}  [task: ${p.goal}]`),
    '',
    `Dead weight: ${kb(r.deadWeight.bytes)} of ${kb(r.deadWeight.total)} tool output (${pct}%) from ${r.deadWeight.results} results was never referenced again. Trimmed at admission: ${kb(r.trimmedBytes)}. Nudges: ${r.nudges}.`,
    'Largest unused sources:',
    ...r.topUnused.map((u) => `  ${kb(u.bytes).padStart(8)}  ${String(u.count).padStart(3)}x  ${u.summary}`),
  ];
  return out.join('\n');
}
