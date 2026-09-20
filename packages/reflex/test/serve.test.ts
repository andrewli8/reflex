import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { serve, readDaemonInfo, daemonJsonPath } from '../src/serve.js';
import { socketProvider } from '../src/providers/socket.js';
import type { Provider } from '../src/provider.js';

const fake: Provider = {
  name: 'fake', maxStateTokens: 400,
  decide: async (_s, q) => Object.fromEntries(Object.keys(q).map((k) => [k, { type: 'boolean', p: 0.9 }])) as never,
};
let home: string; let sock: string; let closeFn: (() => Promise<void>) | undefined;
beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'rx-')); process.env['REFLEX_HOME'] = home; sock = join(home, 'r.sock'); });
afterEach(async () => { await closeFn?.(); closeFn = undefined; });

describe('serve + socket provider', () => {
  it('answers decide over the socket and reports ready', async () => {
    const s = await serve({ provider: async () => fake, socket: sock, providerName: 'fake' });
    closeFn = s.close;
    expect(readDaemonInfo()?.pid).toBe(process.pid);
    const p = socketProvider({ socket: sock, daemonProvider: 'fake', maxStateTokens: 400, spawnEnabled: false });
    const a = await p.decide('state', { redundant: { type: 'boolean', instructions: 'x' } });
    expect(a.redundant).toEqual({ type: 'boolean', p: 0.9 });
  });

  it('throws and spawns when no daemon is listening', async () => {
    let spawned = 0;
    const p = socketProvider({ socket: sock, daemonProvider: 'fake', maxStateTokens: 400, spawnCommand: () => { spawned++; return { cmd: process.execPath, args: ['-e', '0'] }; } });
    await expect(p.decide('s', {})).rejects.toThrow();
    expect(spawned).toBe(1);
  });

  it('reports loading while the provider is still initialising', async () => {
    let resolve!: (p: Provider) => void;
    const s = await serve({ provider: () => new Promise<Provider>((r) => { resolve = r; }), socket: sock });
    closeFn = s.close;
    const p = socketProvider({ socket: sock, daemonProvider: 'fake', maxStateTokens: 400, spawnEnabled: false });
    await expect(p.decide('s', {})).rejects.toThrow('loading');
    resolve(fake);
    await new Promise((r) => setTimeout(r, 10));
    await expect(p.decide('s', {})).resolves.toBeTruthy();
  });

  it('refuses to start while another live pid holds the lock, and replaces a dead one', async () => {
    writeFileSync(daemonJsonPath(), JSON.stringify({ pid: process.ppid, socketPath: sock, startedAt: 0, provider: 'x', version: '0' }));
    await expect(serve({ provider: async () => fake, socket: sock })).rejects.toThrow('another reflex daemon');
    writeFileSync(daemonJsonPath(), JSON.stringify({ pid: 2 ** 22 - 7, socketPath: sock, startedAt: 0, provider: 'x', version: '0' }));
    const s = await serve({ provider: async () => fake, socket: sock });
    closeFn = s.close;
    expect(readDaemonInfo()?.pid).toBe(process.pid);
  });
});
