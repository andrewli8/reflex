import { appendFileSync, chmodSync, mkdirSync, openSync, readFileSync, readSync, closeSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { ReflexEvent } from './critic.js';

/** Root for logs, config, socket, archive. REFLEX_HOME overrides for tests. */
export const reflexHome = (): string => process.env['REFLEX_HOME'] ?? join(homedir(), '.reflex');
export const sessionsDir = (): string => join(reflexHome(), 'sessions');

export function sessionPath(sessionId: string, agentId?: string): string {
  const safe = (s: string) => s.replace(/[^A-Za-z0-9._-]/g, '_');
  return join(sessionsDir(), `${safe(sessionId)}${agentId ? `.${safe(agentId)}` : ''}.jsonl`);
}

/** One line per event, O_APPEND. Parallel hooks append without coordination; no line is ever rewritten. */
export function appendEvent(path: string, e: ReflexEvent): void {
  mkdirSync(join(path, '..'), { recursive: true });
  appendFileSync(path, JSON.stringify(e) + '\n');
}

/**
 * Read the first line (the `meta` event with the cached goal) plus the last `bytes` of the log.
 * A torn line at the tail boundary is dropped; a bad line is skipped.
 */
export function readTail(path: string, bytes = 64 * 1024): ReflexEvent[] {
  let fd: number;
  try { fd = openSync(path, 'r'); } catch { return []; }
  try {
    const size = statSync(path).size;
    const start = Math.max(0, size - bytes);
    const out: ReflexEvent[] = [];
    const parse = (line: string) => { if (!line) return; try { out.push(JSON.parse(line) as ReflexEvent); } catch { /* skip */ } };
    if (start > 0) {
      const headBuf = Buffer.alloc(Math.min(start, 4096));
      readSync(fd, headBuf, 0, headBuf.length, 0);
      const first = headBuf.toString('utf8').split('\n')[0] ?? '';
      if (first.includes('"phase":"meta"')) parse(first);
    }
    const buf = Buffer.alloc(size - start);
    readSync(fd, buf, 0, buf.length, start);
    let text = buf.toString('utf8');
    if (start > 0) text = text.slice(text.indexOf('\n') + 1);
    for (const line of text.split('\n')) parse(line);
    return out;
  } finally { closeSync(fd); }
}

/** Keys stored by `reflex key <provider> <value>`; hook processes often lack the user's shell env. */
export function readSecret(name: string): string | undefined {
  if (process.env[name]) return process.env[name];
  try { return (JSON.parse(readFileSync(join(reflexHome(), 'secrets.json'), 'utf8')) as Record<string, string>)[name]; } catch { return undefined; }
}
export function writeSecret(name: string, value: string): string {
  const path = join(reflexHome(), 'secrets.json');
  mkdirSync(reflexHome(), { recursive: true });
  let current: Record<string, string> = {};
  try { current = JSON.parse(readFileSync(path, 'utf8')); } catch { /* new */ }
  writeFileSync(path, JSON.stringify({ ...current, [name]: value }, null, 2) + '\n', { mode: 0o600 });
  try { chmodSync(path, 0o600); } catch { /* best effort */ }
  return path;
}
