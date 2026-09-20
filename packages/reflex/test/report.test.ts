import { describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Reflex } from '../src/critic.js';
import { appendEvent } from '../src/session.js';
import { buildReport, formatReport30 } from '../src/report.js';

describe('report', () => {
  it('lists near misses, polling loops and dead weight across sessions', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'reflex-report-'));
    const path = join(dir, 'abc.jsonl');
    const r = new Reflex({ cwd: '/p', config: { mode: 'nudge' }, goal: 'Fix the redirect bug. Do not change auth providers.', log: (e) => appendEvent(path, e) });
    let n = 0; const call = (tool: string, args: Record<string, unknown>) => ({ toolUseId: `t${++n}`, tool, args });
    const fp = call('Bash', { command: 'git push --force' }); await r.pre(fp);
    for (let i = 0; i < 3; i++) { const c = call('Bash', { command: 'pgrep -f worker' }); await r.pre(c); await r.post(c, { output: '4242\n' }); }
    for (let i = 0; i < 6; i++) { const c = call('Read', { file_path: `doc${i}.md` }); await r.pre(c); await r.post(c, { output: `section_${i} ` + 'words '.repeat(100) }); }
    const rep = buildReport(30, dir);
    expect(rep.sessions).toBe(1);
    expect(rep.nearMisses).toHaveLength(1);
    expect(rep.nearMisses[0]).toMatchObject({ outcome: 'auto', summary: expect.stringContaining('git push --force') });
    expect(rep.pollingLoops.length).toBeGreaterThanOrEqual(1);
    expect(rep.deadWeight.results).toBeGreaterThanOrEqual(2);
    expect(formatReport30(rep)).toContain('Near misses');
  });
});
