import { closeSync, existsSync, mkdirSync, openSync, readFileSync, unlinkSync, writeSync } from 'node:fs';
import { createServer, type Server } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Provider, Question } from './provider.js';
import { reflexHome } from './session.js';

export const socketPath = (): string => (process.platform === 'win32' ? '\\\\.\\pipe\\reflex' : join(reflexHome(), 'reflex.sock'));
export const daemonJsonPath = (): string => join(reflexHome(), 'daemon.json');

function version(): string {
  try { return (JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json'), 'utf8')) as { version: string }).version; } catch { return 'unknown'; }
}

export interface DaemonInfo { pid: number; socketPath: string; startedAt: number; provider: string; version: string }

/** NDJSON protocol: `{ping:true}` -> `{status:'ready'|'loading'}`; `{id,state,questions}` -> `{id,answers}` | `{id,error}`. */
export interface ServeOptions {
  provider: () => Promise<Provider>;
  socket?: string;
  idleMs?: number;
  providerName?: string;
  onReady?: (info: DaemonInfo) => void;
}

const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch { return false; } };

/** Exclusive create of daemon.json; if a live daemon owns it, return false. Stale files from dead pids are replaced. */
export function takeLock(info: DaemonInfo, path = daemonJsonPath()): boolean {
  mkdirSync(join(path, '..'), { recursive: true });
  if (existsSync(path)) {
    try { const prev = JSON.parse(readFileSync(path, 'utf8')) as DaemonInfo; if (prev.pid !== info.pid && alive(prev.pid)) return false; } catch { /* unreadable: replace */ }
    try { unlinkSync(path); } catch { /* ignore */ }
  }
  try { const fd = openSync(path, 'wx'); writeSync(fd, JSON.stringify(info)); closeSync(fd); return true; } catch { return false; }
}

export function readDaemonInfo(path = daemonJsonPath()): DaemonInfo | undefined {
  try { return JSON.parse(readFileSync(path, 'utf8')) as DaemonInfo; } catch { return undefined; }
}

export async function serve(o: ServeOptions): Promise<{ server: Server; close: () => Promise<void> }> {
  const sock = o.socket ?? socketPath();
  const info: DaemonInfo = { pid: process.pid, socketPath: sock, startedAt: Date.now(), provider: o.providerName ?? 'unknown', version: version() };
  if (!takeLock(info)) throw new Error('another reflex daemon is running');
  if (process.platform !== 'win32' && existsSync(sock)) { try { unlinkSync(sock); } catch { /* ignore */ } }

  let provider: Provider | undefined;
  const loading = o.provider().then((p) => { provider = p; });
  loading.catch(() => { /* reported per request */ });
  let timer: NodeJS.Timeout | undefined;
  const touch = () => { if (timer) clearTimeout(timer); if (o.idleMs) { timer = setTimeout(() => void close(), o.idleMs); timer.unref(); } };

  const conns = new Set<import('node:net').Socket>();
  const server = createServer((conn) => {
    conns.add(conn); conn.once('close', () => conns.delete(conn));
    let buf = '';
    conn.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
        touch();
        void handle(line).then((reply) => { if (!conn.destroyed) conn.write(JSON.stringify(reply) + '\n'); });
      }
    });
    conn.on('error', () => { /* client went away */ });
  });

  async function handle(line: string): Promise<unknown> {
    let req: { id?: string; ping?: boolean; state?: string; questions?: Record<string, Question> };
    try { req = JSON.parse(line); } catch { return { error: 'bad json' }; }
    if (req.ping) return { status: provider ? 'ready' : 'loading', pid: process.pid };
    if (!provider) return { id: req.id, error: 'loading' };
    try { return { id: req.id, answers: await provider.decide(req.state ?? '', req.questions ?? {}) }; }
    catch (e) { return { id: req.id, error: (e as Error).message }; }
  }

  const close = async (): Promise<void> => {
    for (const c of conns) c.destroy();
    await new Promise<void>((r) => server.close(() => r()));
    if (process.platform !== 'win32') { try { unlinkSync(sock); } catch { /* ignore */ } }
    try { if (readDaemonInfo()?.pid === process.pid) unlinkSync(daemonJsonPath()); } catch { /* ignore */ }
    if (timer) clearTimeout(timer);
  };

  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(sock, () => resolve()); });
  touch();
  for (const sig of ['SIGTERM', 'SIGINT'] as const) process.once(sig, () => {
    setTimeout(() => process.exit(0), 5000).unref(); // hard exit if an inference call or a client keeps the loop busy
    void close().then(() => process.exit(0));
  });
  o.onReady?.(info);
  return { server, close };
}
