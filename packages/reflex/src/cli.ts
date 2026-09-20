#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { readdirSync, statSync, unlinkSync } from 'node:fs';
import { collapseSimulation, formatReport, replayTranscript, signalSeparation, type ReplayReport } from './replay.js';

import { loadConfig } from './config-file.js';
import { daemonProvider, providerFromConfig } from './providers/index.js';
import { computeStats, formatStats, loadAllLogs } from './stats.js';
import { buildReport, formatReport30 } from './report.js';
import { appendEvent, readSecret, readTail, reflexHome, sessionsDir, writeSecret } from './session.js';
import { execSync } from 'node:child_process';
import { chmodSync } from 'node:fs';
import { basename } from 'node:path';
import { readDaemonInfo, serve, socketPath } from './serve.js';
import type { ReflexEvent } from './critic.js';

const EVENTS = ['PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'PermissionRequest', 'UserPromptSubmit', 'SessionStart', 'PreCompact'] as const;

/** Write the four Reflex hooks into <cwd>/.claude/settings.json, keeping everything already there. Idempotent. */
export function init(cwd: string, hookCommand = defaultHookCommand()): { path: string; added: string[]; command: string } {
  const dir = join(cwd, '.claude');
  const path = join(dir, 'settings.json');
  mkdirSync(dir, { recursive: true });
  const settings: Record<string, unknown> = existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>) : {};
  const hooks = { ...((settings['hooks'] as Record<string, unknown[]>) ?? {}) };
  const added: string[] = [];
  for (const ev of EVENTS) {
    const list: { matcher?: string; hooks?: { type?: string; command?: string; timeout?: number }[] }[] = [...((hooks[ev] as { matcher?: string; hooks?: { type?: string; command?: string; timeout?: number }[] }[]) ?? [])];
    if (list.some((g) => g.hooks?.some((h) => h.command === hookCommand || h.command?.includes('reflex-hook') || h.command?.includes('hook-bin')))) continue;
    list.push({ matcher: '', hooks: [{ type: 'command', command: hookCommand, timeout: 3 }] });
    hooks[ev] = list;
    added.push(ev);
  }
  writeFileSync(path, JSON.stringify({ ...settings, hooks }, null, 2) + '\n');
  return { path, added, command: hookCommand };
}

/**
 * A stable shim at ~/.reflex/bin/reflex-hook that finds the newest install at run time, so hooks survive
 * upgrades and npx installs: PATH binary, then the global npm root, then the build that ran `init`.
 */
export function writeShim(home = reflexHome()): string {
  const dir = join(home, 'bin');
  mkdirSync(dir, { recursive: true });
  const here = dirname(fileURLToPath(import.meta.url));
  let globalRoot = '';
  try { globalRoot = execSync('npm root -g', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(); } catch { /* no npm */ }
  const candidates = [globalRoot && join(globalRoot, 'agent-reflex', 'dist', 'hook-bin.js'), join(here, 'hook-bin.js')].filter(Boolean);
  const shim = [
    '#!/bin/sh',
    '# Reflex hook shim, written by `reflex init`. Tries a global install first so upgrades take effect without re-running init.',
    'if command -v reflex-hook >/dev/null 2>&1 && [ "$(command -v reflex-hook)" != "$0" ]; then exec reflex-hook "$@"; fi',
    ...candidates.map((c) => `if [ -f "${c}" ]; then exec node "${c}" "$@"; fi`),
    'exit 0',
    '',
  ].join('\n');
  const path = join(dir, 'reflex-hook');
  writeFileSync(path, shim);
  chmodSync(path, 0o755);
  return path;
}

function defaultHookCommand(host: 'claude-code' | 'codex' = 'claude-code'): string {
  const base = process.platform === 'win32' ? `node ${JSON.stringify(join(dirname(fileURLToPath(import.meta.url)), 'hook-bin.js'))}` : writeShim();
  return host === 'codex' ? `${base} --codex` : base;
}

/** Codex reads `<cwd>/.codex/hooks.json` (or `~/.codex/hooks.json`); same event names, regex matchers. Idempotent. */
export function initCodex(cwd: string, hookCommand = defaultHookCommand('codex')): { path: string; added: string[]; command: string } {
  const dir = join(cwd, '.codex');
  const path = join(dir, 'hooks.json');
  mkdirSync(dir, { recursive: true });
  const file: Record<string, unknown> = existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>) : {};
  const hooks = { ...((file['hooks'] as Record<string, unknown[]>) ?? {}) };
  const added: string[] = [];
  for (const ev of EVENTS) {
    const list: { matcher?: string; hooks?: { type?: string; command?: string; timeout?: number }[] }[] = [...((hooks[ev] as { matcher?: string; hooks?: { type?: string; command?: string; timeout?: number }[] }[]) ?? [])];
    if (list.some((g) => g.hooks?.some((h) => h.command === hookCommand || h.command?.includes('reflex-hook') || h.command?.includes('hook-bin')))) continue;
    list.push({ matcher: '.*', hooks: [{ type: 'command', command: hookCommand, timeout: 3 }] });
    hooks[ev] = list;
    added.push(ev);
  }
  writeFileSync(path, JSON.stringify({ ...file, hooks }, null, 2) + '\n');
  return { path, added, command: hookCommand };
}

/** Newest-first list of Claude Code transcripts under ~/.claude/projects. */
export function findTranscripts(root = join(homedir(), '.claude', 'projects'), minBytes = 20_000): string[] {
  const out: { p: string; m: number }[] = [];
  let dirs: string[] = [];
  try { dirs = readdirSync(root); } catch { return []; }
  for (const d of dirs) {
    let files: string[] = [];
    try { files = readdirSync(join(root, d)); } catch { continue; }
    for (const f of files) {
      if (!f.endsWith('.jsonl')) continue;
      const p = join(root, d, f);
      try { const st = statSync(p); if (st.size >= minBytes) out.push({ p, m: st.mtimeMs }); } catch { /* skip */ }
    }
  }
  return out.sort((a, b) => b.m - a.m).map((x) => x.p);
}

async function replay(argv: string[]): Promise<void> {
  const n = Number(argv[argv.indexOf('--last') + 1]) || 20;
  const files = argv.filter((a) => a.endsWith('.jsonl'));
  const outArg = argv.indexOf('--out') >= 0 ? argv[argv.indexOf('--out') + 1] : undefined;
  const jsonIn = argv.filter((a) => a.endsWith('.json') && a !== outArg);
  if (!files.length && jsonIn.length) { const reports = jsonIn.flatMap((j) => JSON.parse(readFileSync(j, 'utf8')) as ReplayReport[]); console.log(formatReport(reports)); console.log('\n' + signalSeparation(reports, 'redundant')); console.log('\n' + signalSeparation(reports, 'relevant', false)); console.log('\n' + collapseSimulation(reports)); return; }
  const paths = files.length ? files : findTranscripts().slice(0, n);
  const config = loadConfig(process.cwd());
  const provider = providerFromConfig(argv.includes('--provider') ? argv[argv.indexOf('--provider') + 1] : config.provider);
  const reports: ReplayReport[] = [];
  const importLogs = argv.includes('--import'); // persist replayed events as session logs so `reflex report` covers history
  for (const p of paths) {
    try {
      const logPath = join(sessionsDir(), `replay-${basename(p, '.jsonl')}.jsonl`);
      if (importLogs) { try { unlinkSync(logPath); } catch { /* fresh */ } }
      reports.push(await replayTranscript(p, { cwd: process.cwd(), config, provider, ...(importLogs ? { log: (e) => appendEvent(logPath, e) } : {}) }));
    } catch (e) { console.error(`skip ${p}: ${(e as Error).message}`); }
  }
  const out = argv.indexOf('--out') >= 0 ? argv[argv.indexOf('--out') + 1] : undefined;
  if (out) writeFileSync(out, JSON.stringify(reports));
  console.log(formatReport(reports));
  console.log('\n' + signalSeparation(reports, 'redundant'));
  console.log('\n' + signalSeparation(reports, 'relevant', false));
  console.log('\n' + collapseSimulation(reports));
}

function newestLog(): string | undefined {
  try {
    return readdirSync(sessionsDir()).filter((f) => f.endsWith('.jsonl')).map((f) => join(sessionsDir(), f))
      .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0];
  } catch { return undefined; }
}

const ICON: Record<string, string> = { execute: '  ', nudge: '~ ', skip: 'x ', ask: '? ', replan: '! ', keep: '  ', trim: '- ', drop: 'x ' };

function renderEvent(e: ReflexEvent): string | undefined {
  if (e.phase === 'pre') return `${ICON[e.applied] ?? '  '}${e.summary.slice(0, 90)}${e.applied !== 'execute' ? `   REFLEX ${e.applied.toUpperCase()}: ${e.reason ?? ''}` : ''}`;
  if (e.phase === 'post' && e.applied !== 'keep') return `${ICON[e.applied] ?? '  '}   REFLEX ${e.applied.toUpperCase()} ${e.bytesIn ?? 0} -> ${e.bytesOut ?? 0} bytes`;
  return undefined;
}

/** Tail the newest session log, printing each decision as it lands. Ctrl-C to stop. */
async function watch(): Promise<void> {
  const path = newestLog();
  if (!path) { console.log(`no session logs in ${sessionsDir()} yet`); return; }
  console.log(`watching ${path}`);
  let seen = 0;
  for (;;) {
    const events = readTail(path, 2 * 1024 * 1024);
    for (const e of events.slice(seen)) { const line = renderEvent(e); if (line) console.log(line); }
    seen = events.length;
    const s = computeStats([events]);
    process.stdout.write(`\r  calls ${s.calls}  nudges ${s.applied['nudge'] ?? 0}  skips ${s.applied['skip'] ?? 0}  asks ${s.asks.total}  trimmed ${Math.round((s.bytesIn - s.bytesOut) / 1024)} KB   `);
    await new Promise((r) => setTimeout(r, 500));
  }
}

function doctor(): void {
  const info = readDaemonInfo();
  const alive = info ? (() => { try { process.kill(info.pid, 0); return true; } catch { return false; } })() : false;
  const cfg = loadConfig(process.cwd());
  console.log([
    `node       ${process.version}`,
    `home       ${reflexHome()}`,
    `config     mode=${cfg.mode} provider=${cfg.provider ?? 'none'}`,
    `keys       jev ${readSecret('TYPESAFE_API_KEY') ? 'ok' : 'missing (reflex key jev <key>)'}   llm ${readSecret('ANTHROPIC_API_KEY') ? 'ok' : 'missing'}`,
    `socket     ${socketPath()} ${existsSync(socketPath()) ? '(exists)' : '(absent)'}`,
    `daemon     ${info ? `pid ${info.pid} provider ${info.provider} ${alive ? 'alive' : 'DEAD (stale daemon.json)'}` : 'not running'}`,
    `logs       ${newestLog() ?? 'none'}`,
    `Reflex advises the host permission system; it is not a security boundary.`,
  ].join('\n'));
}

async function serveCmd(argv: string[]): Promise<void> {
  const name = argv[argv.indexOf('--provider') + 1] || 'laya';
  const idleMin = Number(argv[argv.indexOf('--idle') + 1]) || 30;
  await serve({ provider: () => daemonProvider(name), providerName: name, idleMs: idleMin * 60_000, onReady: (i) => console.log(`reflex serve: ${name} on ${i.socketPath} (pid ${i.pid})`) });
}

/** Delete session logs and archived outputs older than N days (default 30). */
export function clean(days: number, home = reflexHome()): number {
  const cutoff = Date.now() - days * 86_400_000;
  let n = 0;
  for (const sub of ['sessions', 'archive', 'cache']) {
    const dir = join(home, sub);
    let files: string[] = [];
    try { files = readdirSync(dir); } catch { continue; }
    for (const f of files) { const p = join(dir, f); try { if (statSync(p).mtimeMs < cutoff) { unlinkSync(p); n++; } } catch { /* skip */ } }
  }
  return n;
}

async function main(argv: string[]): Promise<void> {
  const [cmd] = argv;
  if (cmd === 'clean') { const d = Number(String(argv[argv.indexOf('--older-than') + 1] ?? '30d').replace(/d$/, '')) || 30; console.log(`removed ${clean(d)} files older than ${d} days`); return; }
  if (cmd === 'replay') return replay(argv.slice(1));
  if (cmd === 'report') { const d = Number(String(argv[argv.indexOf('--days') + 1] ?? '30')) || 30; console.log(formatReport30(buildReport(d))); return; }
  if (cmd === 'stats') { console.log(formatStats(computeStats(loadAllLogs()))); return; }
  if (cmd === 'watch') return watch();
  if (cmd === 'doctor') return doctor();
  if (cmd === 'serve') return serveCmd(argv.slice(1));
  if (cmd === 'init') {
    const root = argv.includes('--global') ? homedir() : process.cwd();
    if (argv.includes('--codex') || argv.includes('--all')) {
      const c = initCodex(root);
      console.log(c.added.length ? `Reflex hooks added to ${c.path} for Codex (${c.added.join(', ')}). Command: ${c.command}.` : `Reflex hooks already present in ${c.path}.`);
      if (!argv.includes('--all')) return;
    }
    const r = init(root);
    console.log(r.added.length ? `Reflex hooks added to ${r.path} (${r.added.join(', ')}). Command: ${r.command}. Mode: nudge. Reflex advises Claude Code's permission system; it is not a security boundary.` : `Reflex hooks already present in ${r.path}.`);
    if (!argv.includes('--no-report')) {
      // First-run moment: show what Reflex would have done on the user's own history, then the near-miss report.
      const paths = findTranscripts().slice(0, 20);
      if (paths.length) {
        console.log(`\nReplaying your last ${paths.length} Claude Code sessions in shadow mode (deterministic, no model)...`);
        await replay(['--last', String(paths.length), '--import', '--provider', 'none']);
        console.log('\n' + formatReport30(buildReport(3650)));
        console.log('\nRe-run any time with: reflex report');
      }
    }
    return;
  }
  if (cmd === 'key') {
    const [provider, value] = [argv[1], argv[2]];
    const names: Record<string, string> = { jev: 'TYPESAFE_API_KEY', typesafe: 'TYPESAFE_API_KEY', llm: 'ANTHROPIC_API_KEY', anthropic: 'ANTHROPIC_API_KEY' };
    const name = provider ? names[provider] : undefined;
    if (!name || !value) { console.log('usage: reflex key <jev|llm> <api-key>   (stored in ~/.reflex/secrets.json, mode 600)'); process.exitCode = 1; return; }
    console.log(`stored ${name} in ${writeSecret(name, value)}`);
    return;
  }
  console.log('usage: reflex init [--global] [--codex|--all] [--no-report] | key <jev|llm> <api-key> | replay [--last N] [--provider none|laya|jev|llm] [--import] [file.jsonl ...] | report [--days 30] | stats | watch | doctor | clean [--older-than 30d] | serve [--provider laya] [--idle MIN]');
  process.exitCode = 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) void main(process.argv.slice(2));
