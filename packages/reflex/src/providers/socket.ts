import { spawn } from 'node:child_process';
import { existsSync, unlinkSync } from 'node:fs';
import { connect } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Answers, Provider, Question } from '../provider.js';
import { socketPath } from '../serve.js';

export interface SocketProviderOptions {
  socket?: string;
  /** Provider name the spawned daemon should load (e.g. `laya`). */
  daemonProvider: string;
  maxStateTokens: number;
  connectTimeoutMs?: number;
  spawnCommand?: () => { cmd: string; args: string[] };
  spawnEnabled?: boolean;
}

class Unavailable extends Error {}

/** One NDJSON round trip. Rejects on connect failure (with the error code) or on a ping/response timeout. */
function roundTrip(sock: string, payload: unknown, timeoutMs: number, signal?: AbortSignal): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const conn = connect(sock);
    let buf = '';
    const timer = setTimeout(() => { conn.destroy(); reject(new Unavailable('timeout')); }, timeoutMs);
    signal?.addEventListener('abort', () => { clearTimeout(timer); conn.destroy(); reject(new Unavailable('aborted')); }, { once: true });
    conn.once('error', (e) => { clearTimeout(timer); reject(e); });
    conn.once('connect', () => conn.write(JSON.stringify(payload) + '\n'));
    conn.on('data', (c) => {
      buf += c.toString('utf8');
      const nl = buf.indexOf('\n');
      if (nl < 0) return;
      clearTimeout(timer); conn.end();
      try { resolve(JSON.parse(buf.slice(0, nl)) as Record<string, unknown>); } catch (e) { reject(e); }
    });
  });
}

function defaultSpawn(daemonProvider: string): { cmd: string; args: string[] } {
  const cli = join(dirname(fileURLToPath(import.meta.url)), '..', 'cli.js');
  return { cmd: process.execPath, args: [cli, 'serve', '--provider', daemonProvider] };
}

/**
 * Provider that talks to `reflex serve`. The connect result is the health probe:
 * ECONNREFUSED = stale socket (unlink, spawn), ENOENT = not started (spawn), timeout = wedged (leave alone).
 * Every failure throws, which the critic treats as "no signals" for this call.
 */
export function socketProvider(o: SocketProviderOptions): Provider {
  const sock = o.socket ?? socketPath();
  const timeout = o.connectTimeoutMs ?? 100;
  const spawnDaemon = () => {
    if (o.spawnEnabled === false) return;
    const { cmd, args } = (o.spawnCommand ?? (() => defaultSpawn(o.daemonProvider)))();
    try { spawn(cmd, args, { detached: true, stdio: 'ignore' }).unref(); } catch { /* fall back */ }
  };
  return {
    name: `socket:${o.daemonProvider}`,
    maxStateTokens: o.maxStateTokens,
    async decide<Q extends Record<string, Question>>(state: string, questions: Q, opts?: { signal?: AbortSignal }): Promise<Answers<Q>> {
      // Connect budget is short (the probe); the answer budget is the caller's abort signal, or 5 s without one.
      let reply: Record<string, unknown>;
      try {
        reply = await roundTrip(sock, { id: '1', state, questions }, opts?.signal ? 5000 : Math.max(timeout, 50) * 50, opts?.signal);
      } catch (e) {
        const code = (e as NodeJS.ErrnoException).code;
        if (code === 'ECONNREFUSED') { if (process.platform !== 'win32' && existsSync(sock)) { try { unlinkSync(sock); } catch { /* ignore */ } } spawnDaemon(); }
        else if (code === 'ENOENT') spawnDaemon();
        throw new Unavailable(code ?? (e as Error).message);
      }
      if (reply['error']) throw new Unavailable(String(reply['error']));
      return reply['answers'] as Answers<Q>;
    },
  };
}
