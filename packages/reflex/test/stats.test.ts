import { describe, expect, it } from 'vitest';
import { computeStats } from '../src/stats.js';
import type { ReflexEvent } from '../src/critic.js';

const ev = (o: Partial<ReflexEvent>): ReflexEvent => ({ ts: 0, step: 1, toolUseId: 't', tool: 'Bash', class: 'exec', summary: '', phase: 'pre', policy: 'execute', applied: 'execute', source: 'deterministic', ...o });

describe('computeStats', () => {
  it('infers ask outcomes from permission and post events', () => {
    const s = computeStats([[
      ev({ toolUseId: 'a', applied: 'ask', policy: 'ask' }), ev({ toolUseId: 'a', phase: 'permission' }), ev({ toolUseId: 'a', phase: 'post', policy: 'keep', applied: 'keep', bytesIn: 10 }),
      ev({ toolUseId: 'b', applied: 'ask', policy: 'ask' }), ev({ toolUseId: 'b', phase: 'permission' }),
      ev({ toolUseId: 'c', applied: 'ask', policy: 'ask' }), ev({ toolUseId: 'c', phase: 'post', policy: 'keep', applied: 'keep', bytesIn: 5, bytesOut: 5 }),
      ev({ toolUseId: 'd', forced: true }), ev({ toolUseId: 'e', suppressed: 'rate', applied: 'execute', policy: 'skip' }),
      ev({ toolUseId: 'f', source: 'model', providerMs: 120 }), ev({ toolUseId: 'g', source: 'model', providerMs: 300 }),
    ]]);
    expect(s.asks).toEqual({ total: 3, approved: 1, denied: 1, auto: 1 });
    expect(s.overrides).toBe(1);
    expect(s.suppressed).toEqual({ rate: 1 });
    expect(s.providerMs.n).toBe(2);
    expect(s.bytesIn).toBe(15);
  });
});
