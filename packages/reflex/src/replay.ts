import { closeSync, openSync, readSync, statSync } from 'node:fs';
import { Reflex, type PreDecision, type ReflexEvent, type ToolCall } from './critic.js';
import type { ReflexConfig } from './config.js';
import type { Provider } from './provider.js';
import { sha } from './state.js';
import { readGoal } from './transcript.js';
import { UsefulnessTracker } from './usefulness.js';
import { responseText } from './adapters/claude-code.js';

export interface ReplayRow { usedAt?: number; lostReference?: boolean; toolUseId: string; tool: string; summary: string; class: string; readOnly: boolean; policy: string; reason?: string; bytes: number; postKind?: string; bytesOut?: number; useful?: boolean; source?: string; signals?: Record<string, number> | null }
export interface ReplayReport {
  path: string; goal: string; calls: number; readCalls: number; labelled: number;
  wouldSkip: number; wouldAsk: number; wouldReplan: number; wouldTrim: number; bytesIn: number; bytesTrimmed: number;
  falseVetoes: number; skipPrecision: number | null; rows: ReplayRow[];
  /** Waste ceiling: labelled read-only calls whose result nothing later used, and the bytes they admitted. */
  wasted: { calls: number; bytes: number; caught: number };
  /** Admission ceiling: bytes of every result (any tool) that nothing later referenced. */
  unreferenced: { calls: number; bytes: number; rereadKb: number };
}

interface Line { type?: string; isSidechain?: boolean; isMeta?: boolean; message?: { content?: unknown } }
interface Block { type: string; id?: string; name?: string; input?: Record<string, unknown>; text?: string; tool_use_id?: string; content?: unknown; is_error?: boolean }

const TEST_CMD = /^(npm|pnpm|yarn|bun)\s+(test|run\s+(test|build|lint|typecheck))|^(pytest|vitest|jest|cargo\s+(test|build)|go\s+(test|build)|make|tsc)\b/;

function* lines(path: string): Generator<Line> {
  const fd = openSync(path, 'r');
  try {
    const size = statSync(path).size;
    const buf = Buffer.alloc(size);
    readSync(fd, buf, 0, size, 0);
    for (const l of buf.toString('utf8').split('\n')) { if (!l) continue; try { yield JSON.parse(l) as Line; } catch { /* skip */ } }
  } finally { closeSync(fd); }
}

/** Shadow-mode replay of one Claude Code transcript. Every call executed for real, so usefulness labels are ground truth. */
export async function replayTranscript(path: string, opts: { cwd?: string; config?: Partial<ReflexConfig>; provider?: Provider; log?: (e: ReflexEvent) => void } = {}): Promise<ReplayReport> {
  const goal = readGoal(path);
  const cwd = goal?.cwd ?? opts.cwd ?? '/'; // the session's own cwd, so "outside cwd" means what it meant at the time
  const events: ReflexEvent[] = [];
  const reflex = new Reflex({ cwd, config: { ...opts.config, mode: 'shadow' }, ...(opts.provider ? { provider: opts.provider } : {}), goal: goal?.goal ?? '', log: (e) => { events.push(e); opts.log?.(e); } });
  if (goal && opts.log) opts.log({ ts: Date.now(), step: 0, toolUseId: '', tool: '', class: '', summary: '', phase: 'meta', policy: 'keep', applied: 'keep', source: 'deterministic', goal: goal.goal });
  const tracker = new UsefulnessTracker();
  if (goal) tracker.context(goal.goal);
  const open = new Map<string, { call: ToolCall; d: PreDecision }>();
  const rows: ReplayRow[] = [];
  let bytesIn = 0; let bytesTrimmed = 0;

  for (const d of lines(path)) {
    if (d.isSidechain) continue;
    const content = d.message?.content;
    if (d.type === 'user' && typeof content === 'string') { tracker.context(content); if (!d.isMeta && !content.trimStart().startsWith('<') && !content.startsWith('[Request interrupted')) reflex.setLatestPrompt(content.trim().slice(0, 600)); continue; }
    if (!Array.isArray(content)) continue;
    for (const b of content as Block[]) {
      if (d.type === 'assistant' && b.type === 'text' && b.text) { tracker.context(b.text); reflex.setPlan(b.text.slice(0, 300)); }
      if (d.type === 'assistant' && b.type === 'tool_use' && b.name && b.id) {
        const args = b.input ?? {};
        const call: ToolCall = { toolUseId: b.id, tool: b.name, args, ...(typeof args['description'] === 'string' ? { description: args['description'] as string } : {}) };
        tracker.step = rows.length;
        tracker.context(JSON.stringify(args));
        const dec = await reflex.pre(call);
        open.set(b.id, { call, d: dec });
        const a = dec.event.action!;
        rows.push({ toolUseId: b.id, tool: b.name, summary: a.summary, class: a.class, readOnly: a.readOnly, policy: dec.policy.kind, ...(dec.policy.reason ? { reason: dec.policy.reason } : {}), bytes: 0, source: dec.event.source, ...(dec.event.signals !== undefined ? { signals: dec.event.signals } : {}) });
      }
      if (d.type === 'user' && b.type === 'tool_result' && b.tool_use_id) {
        const o = open.get(b.tool_use_id);
        if (!o) continue;
        const text = responseText(b.content) ?? '';
        const post = await reflex.post(o.call, { output: text, ...(b.is_error ? { error: true } : {}) });
        const row = rows.find((r) => r.toolUseId === b.tool_use_id)!;
        row.bytes = Buffer.byteLength(text); row.postKind = post.kind; row.bytesOut = post.event.bytesOut ?? row.bytes;
        bytesIn += row.bytes; if (post.kind !== 'keep') bytesTrimmed += row.bytes - (row.bytesOut ?? row.bytes);
        const cmd = o.call.tool === 'Bash' ? String(o.call.args['command'] ?? '') : '';
        if (cmd && TEST_CMD.test(cmd)) tracker.commandResult(b.tool_use_id, cmd, text);
        else tracker.readResult(b.tool_use_id, text, sha(text), post.replacement); // label every result; kept text lets us detect references lost to trimming
        open.delete(b.tool_use_id);
      }
    }
  }
  for (const r of rows) if (tracker.labelled.has(r.toolUseId)) { r.useful = tracker.useful.has(r.toolUseId); const u = tracker.usedAt.get(r.toolUseId); if (u !== undefined) r.usedAt = u; if (tracker.lostReference.has(r.toolUseId)) r.lostReference = true; }
  const skips = rows.filter((r) => r.policy === 'skip');
  const falseVetoes = skips.filter((r) => r.useful === true).length;
  const judged = skips.filter((r) => r.useful !== undefined).length;
  const unref = rows.filter((r) => r.useful === false && !r.tool.match(/^(Edit|Write|MultiEdit|NotebookEdit)$/));
  const unreferenced = { calls: unref.length, bytes: unref.reduce((a, r) => a + r.bytes, 0), rereadKb: rows.reduce((a, r, i) => a + (r.useful === false ? r.bytes * (rows.length - i) : 0), 0) / 1024 };
  const wastedRows = rows.filter((r) => r.readOnly && r.useful === false);
  const wasted = { calls: wastedRows.length, bytes: wastedRows.reduce((a, r) => a + r.bytes, 0), caught: wastedRows.filter((r) => r.policy === 'skip').length };
  return {
    wasted, unreferenced, path, goal: goal?.goal.slice(0, 80) ?? '', calls: rows.length, readCalls: rows.filter((r) => r.readOnly).length, labelled: tracker.labelled.size,
    wouldSkip: skips.length, wouldAsk: rows.filter((r) => r.policy === 'ask').length, wouldReplan: rows.filter((r) => r.policy === 'replan').length,
    wouldTrim: rows.filter((r) => r.postKind === 'trim' || r.postKind === 'drop').length, bytesIn, bytesTrimmed,
    falseVetoes, skipPrecision: judged ? (judged - falseVetoes) / judged : null, rows,
  };
}

/** How well a signal separates wasted reads from useful ones, and what precision/recall each threshold would give. */
/** Simulated retroactive collapse: a result shrinks to one line K steps after admission unless referenced by then. */
export function collapseSimulation(reports: ReplayReport[]): string {
  const out = ['collapse-after-K  saved(of tool-output tokens)  false-collapses(referenced later)'];
  const total = reports.reduce((a, r) => a + r.rows.reduce((b, x, i) => b + x.bytes * (r.rows.length - i), 0), 0);
  for (const K of [2, 5, 10]) {
    let saved = 0; let falseC = 0;
    for (const r of reports) {
      const n = r.rows.length;
      r.rows.forEach((x, i) => {
        if (x.useful === undefined && x.usedAt === undefined && x.bytes === 0) return;
        const late = x.usedAt !== undefined && x.usedAt > i + K;
        if (late) falseC++;
        else saved += x.bytes * Math.max(0, n - (i + K));
      });
    }
    out.push(`      ${String(K).padStart(2)}           ${(total ? (100 * saved) / total : 0).toFixed(0).padStart(3)}%                       ${falseC}`);
  }
  return out.join('\n');
}

export function signalSeparation(reports: ReplayReport[], signal = 'redundant', higherMeansWaste = true): string {
  const rows = reports.flatMap((r) => r.rows).filter((r) => r.readOnly && r.useful !== undefined && r.signals && signal in r.signals);
  if (!rows.length) return `no labelled read calls carry a '${signal}' signal (deterministic provider?)`;
  const val = (r: ReplayRow) => r.signals![signal]!;
  const useful = rows.filter((r) => r.useful).map(val); const wasted = rows.filter((r) => !r.useful).map(val);
  const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
  const median = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)]! : NaN; };
  // AUC via rank comparison: P(score of a wasted call > score of a useful call).
  let wins = 0; for (const w of wasted) for (const u of useful) wins += w > u ? 1 : w === u ? 0.5 : 0;
  let auc = useful.length && wasted.length ? wins / (useful.length * wasted.length) : NaN;
  if (!higherMeansWaste) auc = 1 - auc;
  const lines = [`${signal}: ${rows.length} labelled reads (${wasted.length} wasted, ${useful.length} useful). mean wasted ${mean(wasted).toFixed(2)} vs useful ${mean(useful).toFixed(2)}; median ${median(wasted).toFixed(2)} vs ${median(useful).toFixed(2)}; AUC ${auc.toFixed(2)} (0.5 = no information)`];
  lines.push(`${higherMeansWaste ? 'threshold' : '1-thresh '}  would-skip  precision  recall(of wasted)  bytes-saved`);
  for (const t of [0.5, 0.6, 0.7, 0.8, 0.9]) {
    const hit = rows.filter((r) => (higherMeansWaste ? val(r) >= t : val(r) <= 1 - t)); const tp = hit.filter((r) => !r.useful);
    lines.push(`   ${t.toFixed(1)}       ${String(hit.length).padStart(5)}      ${(hit.length ? tp.length / hit.length : 0).toFixed(2)}       ${(wasted.length ? tp.length / wasted.length : 0).toFixed(2)}            ${(tp.reduce((a, r) => a + r.bytes, 0) / 1024).toFixed(0)} KB`);
  }
  return lines.join('\n');
}

export function formatReport(reports: ReplayReport[]): string {
  const sum = (f: (r: ReplayReport) => number) => reports.reduce((a, r) => a + f(r), 0);
  const skips = sum((r) => r.wouldSkip); const fv = sum((r) => r.falseVetoes);
  const judged = reports.reduce((a, r) => a + r.rows.filter((x) => x.policy === 'skip' && x.useful !== undefined).length, 0);
  const prec = judged ? ((judged - fv) / judged).toFixed(2) : 'n/a';
  const skippedBytes = reports.flatMap((r) => r.rows).filter((r) => r.policy === 'skip').reduce((a, r) => a + r.bytes, 0);
  const wc = sum((r) => r.wasted.calls); const wb = sum((r) => r.wasted.bytes); const caught = sum((r) => r.wasted.caught);
  const savedKb = (skippedBytes + sum((r) => r.bytesTrimmed)) / 1024;
  // Every admitted byte is re-sent to the model on each later step, so weight saved bytes by the steps that followed.
  const rereadKb = (rows: ReplayRow[], saved: (r: ReplayRow) => number) => rows.reduce((a, r, i) => a + saved(r) * (rows.length - i), 0) / 1024;
  const rereadSaved = reports.reduce((a, r) => a + rereadKb(r.rows, (x) => (x.policy === 'skip' ? x.bytes : x.postKind && x.postKind !== 'keep' ? x.bytes - (x.bytesOut ?? x.bytes) : 0)), 0);
  const rereadCeiling = reports.reduce((a, r) => a + rereadKb(r.rows, (x) => (x.readOnly && x.useful === false ? x.bytes : 0)), 0);
  const rereadTotal = reports.reduce((a, r) => a + rereadKb(r.rows, (x) => x.bytes), 0);
  const head = [
    `Reflex would have skipped ${skips} of ${sum((r) => r.calls)} calls (precision ${prec}, ${fv} false vetoes), asked on ${sum((r) => r.wouldAsk)}, replanned ${sum((r) => r.wouldReplan)}, trimmed ${(sum((r) => r.bytesTrimmed) / 1024).toFixed(0)} KB of ${(sum((r) => r.bytesIn) / 1024).toFixed(0)} KB tool output across ${reports.length} sessions.`,
    `Waste ceiling (reads whose result nothing later used): ${wc} calls, ${(wb / 1024).toFixed(0)} KB. Reflex caught ${caught} of them (recall ${wc ? (caught / wc).toFixed(2) : 'n/a'}).`,
    `Never referenced again (any tool): ${sum((r) => r.unreferenced.calls)} results, ${(sum((r) => r.unreferenced.bytes) / 1024).toFixed(0)} KB admitted once, ~${Math.round((sum((r) => r.unreferenced.rereadKb) * 1024) / 4 / 1000)}K re-read-weighted tokens (${rereadTotal ? (100 * sum((r) => r.unreferenced.rereadKb) / rereadTotal).toFixed(0) : 0}% of tool-output tokens).`,
    `Trims: ${reports.flatMap((r) => r.rows).filter((r) => r.postKind === 'trim').length}, of which ${reports.flatMap((r) => r.rows).filter((r) => r.lostReference).length} cut an identifier the agent later used (false trims).`,
    `Context saved: ~${savedKb.toFixed(0)} KB of tool output admitted once; weighted by the steps that re-read it, ~${Math.round((rereadSaved * 1024) / 4 / 1000)}K input tokens of ${Math.round((rereadTotal * 1024) / 4 / 1000)}K attributable to tool output (${rereadTotal ? (100 * rereadSaved / rereadTotal).toFixed(1) : '0'}%). Skipping every wasted read would reach ${Math.round((rereadCeiling * 1024) / 4 / 1000)}K.`,
  ].join('\n');
  const table = reports.map((r) => `${r.calls.toString().padStart(5)} calls ${r.wouldSkip.toString().padStart(4)} skip ${r.falseVetoes.toString().padStart(3)} false ${r.wouldAsk.toString().padStart(3)} ask ${(r.bytesTrimmed / 1024).toFixed(0).padStart(6)} KB trimmed  ${r.goal || '(no goal)'}`).join('\n');
  return `${head}\n\n${table}`;
}
