import { appendFileSync, mkdirSync, openSync, readSync, closeSync, statSync } from 'node:fs';
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
