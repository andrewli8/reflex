import { describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readGoal, readPlan } from '../src/transcript.js';

const line = (o: object) => JSON.stringify(o);
const fixture = [
  line({ type: 'attachment', uuid: '0' }),
  line({ type: 'user', isMeta: true, message: { role: 'user', content: '<system-reminder>x</system-reminder>' } }),
  line({ type: 'user', message: { role: 'user', content: '<command-name>/login</command-name>' } }),
  line({ type: 'user', message: { role: 'user', content: '\n\nFix the login redirect bug. Do not change authentication providers.' } }),
  line({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'I will read auth.ts first.' }, { type: 'tool_use', id: 'toolu_1', name: 'Read', input: { file_path: 'auth.ts' } }] } }),
  line({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'export {}' }] }, toolUseResult: {} }),
  'not json at all',
  line({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Next: check routes.ts for the redirect handler.' }] } }),
].join('\n') + '\n';

describe('transcript', () => {
  it('finds the first real prompt and the latest assistant text', () => {
    const p = join(mkdtempSync(join(tmpdir(), 'reflex-')), 't.jsonl');
    writeFileSync(p, fixture);
    expect(readGoal(p)).toEqual({ goal: 'Fix the login redirect bug. Do not change authentication providers.', constraints: ['Do not change authentication providers.'] });
    expect(readPlan(p)).toBe('Next: check routes.ts for the redirect handler.');
  });
  it('tolerates a missing file', () => {
    expect(readGoal('/nope/none.jsonl')).toBeUndefined();
    expect(readPlan('/nope/none.jsonl')).toBe('');
  });
});
