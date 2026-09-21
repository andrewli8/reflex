import { describe, expect, it } from 'vitest';
import { Reflex, type ReflexEvent } from '../src/critic.js';
import { defaultConfig, type ReflexConfig } from '../src/config.js';
import { serialize, estimateTokens, type ControlState } from '../src/state.js';

const cwd = '/home/u/proj';
function mk(over: Partial<ReflexConfig> = {}) {
  const events: ReflexEvent[] = [];
  const r = new Reflex({ cwd, config: { ...defaultConfig, mode: 'enforce', ...over }, goal: 'Fix the login redirect bug. Do not change authentication providers.', log: (e) => events.push(e) });
  return { r, events };
}
let n = 0;
const call = (tool: string, args: Record<string, unknown>, description?: string) =>
  ({ toolUseId: `t${++n}`, tool, args, ...(description ? { description } : {}) });

describe('Reflex.pre deterministic', () => {
  it('skips the first exact repeat and replans on a cycle', async () => {
    const { r } = mk();
    const seq = [] as string[];
    for (let i = 0; i < 6; i++) {
      const c = i % 2 === 0 ? call('Grep', { pattern: 'auth' }) : call('Read', { file_path: 'auth.ts' });
      const d = await r.pre(c);
      seq.push(d.policy.kind);
      await r.post(c, { output: 'x'.repeat(10) });
    }
    expect(seq.slice(0, 3)).toEqual(['execute', 'execute', 'skip']);
    expect(seq).toContain('replan');
  });

  it('executes a reread after an edit', async () => {
    const { r } = mk();
    for (const c of [call('Read', { file_path: 'a.ts' }), call('Edit', { file_path: 'a.ts' })]) { await r.pre(c); await r.post(c, { output: 'ok' }); }
    expect((await r.pre(call('Read', { file_path: 'a.ts' }))).policy.kind).toBe('execute');
  });

  it('asks on destructive patterns, even with neverIntervene and even when forced', async () => {
    const { r } = mk({ neverIntervene: ['Bash'] });
    expect((await r.pre(call('Bash', { command: 'git push --force' }))).policy.kind).toBe('ask');
    expect((await r.pre(call('Bash', { command: 'git push --force' }, 'reflex:force'))).policy.kind).toBe('ask');
    expect((await r.pre(call('Bash', { command: 'git push --force-with-lease' }))).policy.kind).toBe('execute');
  });

  it('never skips a mutating duplicate', async () => {
    const { r } = mk();
    for (let i = 0; i < 4; i++) {
      const c = call('Bash', { command: 'rm -rf build' });
      expect((await r.pre(c)).policy.kind).not.toBe('skip');
      await r.post(c, { output: '' });
    }
  });

  it('neverIntervene suppresses a duplicate read', async () => {
    const { r, events } = mk({ neverIntervene: ['Bash'] });
    for (let i = 0; i < 3; i++) { const c = call('Bash', { command: 'ls' }); expect((await r.pre(c)).policy.kind).toBe('execute'); await r.post(c, { output: 'a' }); }
    expect(events.some((e) => e.suppressed === 'neverIntervene')).toBe(true);
  });

  it('honours reflex:force on a read', async () => {
    const { r, events } = mk();
    const c1 = call('Read', { file_path: 'a.ts' }); await r.pre(c1); await r.post(c1, { output: 'a' });
    const d = await r.pre(call('Read', { file_path: 'a.ts' }, 'rereading, reflex:force'));
    expect(d.policy.kind).toBe('execute');
    expect(events.at(-1)?.forced).toBe(true);
  });

  it('rate-caps interventions', async () => {
    const { r, events } = mk({ maxInterventionsPer5Steps: 2 });
    for (const f of ['a', 'b', 'c']) { const c = call('Read', { file_path: f }); await r.pre(c); await r.post(c, { output: f }); }
    const kinds: string[] = [];
    for (const f of ['a', 'b', 'c']) { const c = call('Read', { file_path: f }); kinds.push((await r.pre(c)).policy.kind); await r.post(c, { output: f }); }
    expect(kinds).toEqual(['skip', 'skip', 'skip']);
    expect(events.filter((e) => e.suppressed === 'rate').length).toBe(1);
  });
});

describe('mode cap', () => {
  it('turns skip into allow+note in nudge and deny in enforce', async () => {
    for (const mode of ['nudge', 'enforce'] as const) {
      const { r, events } = mk({ mode });
      const c1 = call('Read', { file_path: 'a.ts' }); await r.pre(c1); await r.post(c1, { output: 'a' });
      const d = await r.pre(call('Read', { file_path: 'a.ts' }));
      expect(d.policy.kind).toBe('skip');
      expect(d.host.action).toBe(mode === 'nudge' ? 'allow' : 'deny');
      if (mode === 'nudge') expect(d.host.note).toContain('reflex');
      expect(events.at(-1)).toMatchObject({ policy: 'skip', applied: mode === 'nudge' ? 'nudge' : 'skip' });
    }
  });
});

describe('Reflex.post', () => {
  it('keeps errors, trims identical large results, keeps small json', async () => {
    const { r } = mk();
    const big = 'line\n'.repeat(1000);
    const c1 = call('Bash', { command: 'npm test' });
    await r.pre(c1);
    expect((await r.post(c1, { output: 'Error: boom\n' + big, error: true })).kind).toBe('keep');
    const c2 = call('Bash', { command: 'cat log' });
    await r.pre(c2);
    expect((await r.post(c2, { output: big })).kind).toBe('keep');
    const c3 = call('Bash', { command: 'cat log2' });
    await r.pre(c3);
    const d = await r.post(c3, { output: big });
    expect(d.kind).toBe('trim');
    expect(d.replacement!.length).toBeLessThan(big.length);
    const c4 = call('Read', { file_path: 'x.json' });
    await r.pre(c4);
    expect((await r.post(c4, { output: JSON.stringify({ a: 'x'.repeat(3000) }) })).kind).toBe('keep');
  });
});

describe('serialize', () => {
  it('fits the Laya budget and keeps constraints and proposed action', () => {
    const state: ControlState = {
      goal: 'G'.repeat(600), constraints: ['do not change authentication providers'], plan: 'P'.repeat(300),
      recentActions: Array.from({ length: 8 }, (_, i) => ({ tool: 'Read', class: 'read' as const, readOnly: true, summary: `Read src/file${i}.ts`, signature: `s${i}`, paths: [], step: i, outcome: 'ok' as const, resultDigest: 'x'.repeat(80) })),
      proposedAction: { tool: 'Bash', class: 'vcs' as const, readOnly: false, summary: 'git push --force origin main', signature: 'z', paths: [], step: 9 },
      step: 9, cwd,
    };
    const s = serialize(state, 400);
    expect(estimateTokens(s)).toBeLessThanOrEqual(400);
    expect(s).toContain('CONSTRAINTS: do not change authentication providers');
    expect(s).toContain('PROPOSED [vcs]: git push --force origin main');
  });
});

describe('question sets', () => {
  it('gives small providers one question and large providers the full set', async () => {
    const { questionsFor } = await import('../src/questions.js');
    expect(Object.keys(questionsFor(false, 400))).toEqual(['outOfScope']);
    expect(Object.keys(questionsFor(true, 400))).toEqual(['redundant']);
    expect(Object.keys(questionsFor(false, 8000))).toEqual(['outOfScope', 'destructive', 'irreversible']);
    expect(Object.keys(questionsFor(true, 8000))).toEqual(['redundant', 'relevant', 'outOfScope']);
  });
});

describe('provider signals', () => {
  it('records signals on the event and applies the policy to them', async () => {
    const provider = { name: 'fake', maxStateTokens: 8000, decide: async (_s: string, q: Record<string, unknown>) => Object.fromEntries(Object.keys(q).map((k) => [k, { type: 'boolean', p: k === 'outOfScope' ? 0.97 : 0.1 }])) as never };
    const { r } = mk({ mode: 'enforce' });
    const r2 = new Reflex({ cwd, config: { ...defaultConfig, mode: 'enforce' }, goal: 'Fix bug. Do not change auth providers.', provider, log: () => {} });
    void r;
    const d = await r2.pre(call('Edit', { file_path: 'auth0.config.ts' }));
    expect(d.policy.kind).toBe('ask');
    expect(d.event.signals).toMatchObject({ outOfScope: 0.97 });
    expect(d.event.source).toBe('model');
  });
});

describe('trim', () => {
  it('keeps error-looking lines from the middle and archives the original', async () => {
    const { mkdtempSync, readdirSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const dir = mkdtempSync(join(tmpdir(), 'reflex-archive-'));
    const r = new Reflex({ cwd, config: { ...defaultConfig, mode: 'enforce' }, archiveDir: dir, log: () => {} });
    const big = 'ok line\n'.repeat(1000) + 'FAIL src/auth.test.ts > redirects home\n  AssertionError: expected 302\n' + 'ok line\n'.repeat(1000);
    const c = call('Bash', { command: 'npm test' });
    await r.pre(c);
    const c2 = call('Bash', { command: 'npm run test:again' });
    await r.pre(c2);
    await r.post(c, { output: big });
    const d = await r.post(c2, { output: big + '\nextra tail line' }); // large, not identical -> head/tail trim keeping error lines
    expect(d.kind).toBe('trim');
    expect(d.replacement).toContain('FAIL src/auth.test.ts');
    expect(d.replacement).toContain('AssertionError');
    expect(d.replacement).toContain('Full output: Read');
    expect(readdirSync(dir).length).toBeGreaterThanOrEqual(1);
  });
});

describe('cross-process cache and modelClasses', () => {
  it('serves the second process from disk and skips the model for excluded classes', async () => {
    const { mkdtempSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const dir = mkdtempSync(join(tmpdir(), 'reflex-cache-'));
    let calls = 0;
    const provider = { name: 'fake', maxStateTokens: 8000, decide: async (_s: string, q: Record<string, unknown>) => { calls++; return Object.fromEntries(Object.keys(q).map((k) => [k, { type: 'boolean', p: 0.1 }])) as never; } };
    const mkr = () => new Reflex({ cwd, config: { ...defaultConfig, modelClasses: ['write'] }, goal: 'g', provider, cacheDir: dir, log: () => {} });
    const a = await mkr().pre(call('Edit', { file_path: 'x.ts' }));
    expect(a.event.cached).toBe(false);
    const b = await mkr().pre(call('Edit', { file_path: 'x.ts' }));
    expect(b.event.cached).toBe(true);
    expect(calls).toBe(1);
    const c = await mkr().pre(call('Read', { file_path: 'y.ts' }));
    expect(c.event.source).toBe('deterministic');
    expect(calls).toBe(1);
  });
});

describe('polling warning and exec trim band', () => {
  it('warns on the third identical command with identical output, never denies', async () => {
    const { r } = mk({ mode: 'enforce' });
    let last: Awaited<ReturnType<typeof r.pre>> | undefined;
    for (let i = 0; i < 3; i++) { const c = call('Bash', { command: 'pgrep -f worker | head -1' }); last = await r.pre(c); await r.post(c, { output: '12345\n' }); }
    expect(last!.policy.kind).toBe('warn');
    expect(last!.host.action).toBe('allow');
    expect(last!.host.note).toContain('identical output');
  });
  it('trims a 1 KB command output to head and tail but leaves a 1 KB file read alone', async () => {
    const { r } = mk({ mode: 'nudge' });
    const out = 'added 1 package\n'.repeat(70);
    const c = call('Bash', { command: 'npm install' }); await r.pre(c);
    const d = await r.post(c, { output: out });
    expect(d.kind).toBe('trim');
    expect(d.replacement!.length).toBeLessThan(out.length * 0.6);
    const c2 = call('Read', { file_path: 'notes.txt' }); await r.pre(c2);
    expect((await r.post(c2, { output: 'x'.repeat(1100) })).kind).toBe('keep');
    const help = ['Usage: eas submit [options]', '', 'Submit app binaries to app stores', '', 'Options:', '  -p, --platform <platform>   android | ios | all', '  --profile <name>            submit profile from eas.json', '  --latest                    submit the latest build', '  --id <id>                   build id to submit', '  --path <path>               local archive to submit', '  --url <url>                 archive url', '  --verbose                   print debug output', '  --wait                      wait for submission to complete', '  --non-interactive           run in non-interactive mode', '  --json                      output as json', '', 'Examples:', '  eas submit -p ios --latest', '  eas submit --path ./app.aab', '', 'Learn more: https://docs.expo.dev/submit/introduction/'].join('\n');
    const c3 = call('Bash', { command: 'eas submit --help' }); await r.pre(c3);
    expect((await r.post(c3, { output: help })).kind).toBe('keep'); // dense text under 2 KB stays
  });
  it('puts the earlier result digest into a duplicate-skip note', async () => {
    const { r } = mk({ mode: 'nudge' });
    const c = call('Read', { file_path: 'a.ts' }); await r.pre(c); await r.post(c, { output: 'export const login = 1;' });
    const d = await r.pre(call('Read', { file_path: 'a.ts' }));
    expect(d.host.note).toContain('export const login');
  });
});

describe('reference tracking, gauge and ledger', () => {
  it('marks results referenced by later calls, reports dead weight, and builds a ledger', async () => {
    const { r } = mk({ mode: 'nudge', gauge: { enabled: true, minBytes: 100, everySteps: 1 } });
    const c1 = call('Read', { file_path: 'src/auth.ts' }); await r.pre(c1);
    await r.post(c1, { output: 'export function handleRedirect(req) { return req.query.next_url }' });
    const c2 = call('Read', { file_path: 'README.md' }); await r.pre(c2);
    const p2 = await r.post(c2, { output: 'Runs on Kubernetes with helm charts under k8s/ and ' + 'filler '.repeat(60) });
    const c3 = call('Grep', { pattern: 'next_url' }); const d3 = await r.pre(c3); await r.post(c3, { output: 'src/routes.ts:12: next_url' });
    expect(d3.event.refs).toEqual([1]);
    for (let i = 0; i < 4; i++) { const c = call('Bash', { command: `npm run step${i}` }); await r.pre(c); await r.post(c, { output: `${i}` }); }
    const dw = r.deadWeight();
    expect(dw.results).toBeGreaterThanOrEqual(1);
    expect(dw.bytes).toBeGreaterThanOrEqual(400);
    expect(p2.userMessage ?? '').toBe(''); // too early: only the gauge on later posts fires
    const led = r.ledger();
    expect(led).toContain('src/auth.ts [used]');
    expect(led).toContain('README.md [unused]');
    expect(led).toContain('COMMANDS');
  });
  it('emits the gauge message once dead weight crosses the threshold, rate limited', async () => {
    const { r } = mk({ mode: 'nudge', gauge: { enabled: true, minBytes: 500, everySteps: 3 } });
    const msgs: string[] = [];
    for (let i = 0; i < 10; i++) { const c = call('Read', { file_path: `f${i}.txt` }); await r.pre(c); const p = await r.post(c, { output: `content_${i} ` + 'x'.repeat(300) }); if (p.userMessage) msgs.push(p.userMessage); }
    expect(msgs.length).toBeGreaterThanOrEqual(1);
    expect(msgs.length).toBeLessThanOrEqual(3);
    expect(msgs[0]).toContain('/compact');
  });
});

describe('constraint extraction', () => {
  it('keeps imperatives and drops descriptive "do not only" prose', async () => {
    const { extractConstraints } = await import('../src/state.js');
    const text = '> Long-running agents do not only need better reasoning. They need fast reflexes.\nFix the redirect bug. Do not change authentication providers. Only touch application code; never push to main. This must be the cause.';
    expect(extractConstraints(text)).toEqual(['Do not change authentication providers.', 'Only touch application code;', 'never push to main.']);
    const noise = 'Only thing is, would Jev answer fast enough?\nOnly if it is cheap.\nKEEP / DROP\nKEEP\nAnd I have never worked on the enterprise side.\nIt\'ll never scale to a Costco.\nTypes generated to `src/db.ts` (do not hand-edit).\nThe rule engine — may route work but never mark a rep.\nDon\'t be the chief blocking officer.\nnow also never delete migrations';
    expect(extractConstraints(noise)).toEqual(["Don't be the chief blocking officer.", 'now also never delete migrations']);
  });
});

describe('identical collapse, learning, failures', () => {
  it('collapses an identical result to one line naming the earlier step', async () => {
    const { r } = mk({ mode: 'nudge' });
    const out = 'status line\n'.repeat(300);
    const c1 = call('Bash', { command: 'git status' }); await r.pre(c1); await r.post(c1, { output: out });
    const c2 = call('Bash', { command: 'git status --short' }); await r.pre(c2);
    const d = await r.post(c2, { output: out });
    expect(d.kind).toBe('trim');
    expect(d.replacement).toMatch(/identical to step 1/);
    expect(d.replacement!.length).toBeLessThan(200);
  });
  it('stops nudging a signature after the user forces it', async () => {
    const { r, events } = mk({ mode: 'enforce' });
    const c1 = call('Read', { file_path: 'a.ts' }); await r.pre(c1); await r.post(c1, { output: 'x' });
    expect((await r.pre(call('Read', { file_path: 'a.ts' }))).host.action).toBe('deny');
    await r.pre(call('Read', { file_path: 'a.ts' }, 'reflex:force'));
    const again = await r.pre(call('Read', { file_path: 'a.ts' }));
    expect(again.host.action).toBe('allow');
    expect(events.at(-1)?.suppressed).toBe('learned');
  });
  it('learns from history: a nudged call whose result was used is not nudged again', async () => {
    const { r, events } = mk({ mode: 'nudge' });
    const c1 = call('Read', { file_path: 'cfg.json' }); await r.pre(c1); await r.post(c1, { output: '{"port_number": 8080}' });
    const c2 = call('Read', { file_path: 'cfg.json' }); await r.pre(c2); await r.post(c2, { output: '{"port_number": 9090, "new_key_x": 1}' });
    const c3 = call('Grep', { pattern: 'new_key_x' }); await r.pre(c3); await r.post(c3, { output: 'found' });
    const r2 = new Reflex({ cwd, config: { ...defaultConfig, mode: 'nudge' }, history: events });
    const d = await r2.pre(call('Read', { file_path: 'cfg.json' }));
    expect(d.event.suppressed).toBe('learned');
  });
  it('lists failures in the ledger with retry outcome', async () => {
    const { r } = mk({ mode: 'nudge' });
    const c1 = call('Bash', { command: 'npm test' }); await r.pre(c1); await r.post(c1, { output: 'FAIL 1 test', error: true });
    const c2 = call('Bash', { command: 'npm test' }); await r.pre(c2); await r.post(c2, { output: 'ok 12 tests' });
    const c3 = call('Bash', { command: 'npm run lint' }); await r.pre(c3); await r.post(c3, { output: 'Error: x', error: true });
    const led = r.ledger();
    expect(led).toMatch(/npm test failed at step 1, passed at step 2/);
    expect(led).toMatch(/npm run lint failed at step 3, never retried/);
  });
});

describe('redaction', () => {
  it('strips secrets from summaries, digests, archives and provider state', async () => {
    const { redact } = await import('../src/state.js');
    expect(redact('export TYPESAFE_API_KEY="apikey_0000000000000000000000000000000000_00000000" && curl -H "Authorization: Bearer sk-ant-abcdefghijklmnopqrstuvwxyz"')).toBe('export TYPESAFE_API_KEY=[redacted] && curl -H "Authorization: [redacted] [redacted]"');
    expect(redact('password=hunter22 token: ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ12 sha256:a920c3e99340de2fe')).toBe('password=[redacted] token: [redacted] sha256:a920c3e99340de2fe');
    const seen: string[] = [];
    const provider = { name: 'fake', maxStateTokens: 8000, decide: async (st: string, q: Record<string, unknown>) => { seen.push(st); return Object.fromEntries(Object.keys(q).map((k) => [k, { type: 'boolean', p: 0.1 }])) as never; } };
    const r = new Reflex({ cwd, goal: 'Deploy. My key is sk-ant-secretsecretsecretsecret ok', provider, log: () => {} });
    const c = call('Bash', { command: 'AWS_SECRET_ACCESS_KEY=abcdef123456789 aws s3 ls' });
    const d = await r.pre(c);
    expect(d.event.summary).not.toContain('abcdef123456789');
    expect(seen[0]).not.toContain('secretsecret');
    expect(seen[0]).not.toContain('abcdef123456789');
    await r.post(c, { output: 'x'.repeat(2500) + '\nAKIAIOSFODNN7EXAMPLE\n' });
    expect(JSON.stringify(r.recentActions)).not.toContain('AKIAIOSFODNN7EXAMPLE');
  });
});

describe('levels', () => {
  it('presets map to the right behaviour and explicit keys override', async () => {
    const { applyLevel } = await import('../src/config.js');
    expect(applyLevel('watch')).toMatchObject({ mode: 'shadow', provider: 'none' });
    expect(applyLevel('ask')).toMatchObject({ level: 'ask' });
    expect(applyLevel('ask')).toMatchObject({ mode: 'enforce', provider: 'jev', askBecomesDeny: false });
    expect(applyLevel('auto')).toMatchObject({ mode: 'enforce', askBecomesDeny: true, collapse: { after: 3, checkpointEvery: 5 } });
    expect(applyLevel('ultra').routing.enabled).toBe(true);
  });
  it('auto denies a destructive call with a reason instead of asking', async () => {
    const r = new Reflex({ cwd, config: { ...defaultConfig, mode: 'enforce', askBecomesDeny: true }, goal: 'g', log: () => {} });
    const d = await r.pre(call('Bash', { command: 'git push --force' }));
    expect(d.host.action).toBe('deny');
    expect(d.host.reason).toContain('unattended');
    expect(d.event.applied).toBe('ask');
  });
  it('routes to the small model only on a confident small verdict', async () => {
    const mk2 = (choice: string, confidence: number) => new Reflex({ cwd, goal: 'g', config: { ...defaultConfig, routing: { enabled: true } }, provider: { name: 'fake', maxStateTokens: 8000, decide: async () => ({ model: { type: 'choice', choice, confidence, probabilities: { small: confidence, large: 1 - confidence } } }) as never }, log: () => {} });
    expect(await mk2('small', 0.9).route()).toBe('small');
    expect(await mk2('small', 0.5).route()).toBe('large');
    expect(await mk2('large', 0.9).route()).toBe('large');
    const off = new Reflex({ cwd, goal: 'g', config: { ...defaultConfig, routing: { enabled: false } }, log: () => {} });
    expect(await off.route()).toBe('large');
  });
});

describe('edit summaries', () => {
  it('include what changes so the decision model can judge scope', async () => {
    const { summarize } = await import('../src/state.js');
    expect(summarize('Edit', { file_path: 'src/auth0.config.ts', old_string: 'provider: "auth0"', new_string: 'provider: "clerk"' })).toBe('Edit src/auth0.config.ts "provider: "auth0"" → "provider: "clerk""');
    expect(summarize('Write', { file_path: 'a.ts', content: 'export const x = 1;\n'.repeat(9) })).toContain('"export const x = 1;');
    expect(summarize('Edit', { file_path: 'k.env', new_string: 'API_KEY=apikey_0123456789abcdefghijklmnop' })).not.toContain('0123456789');
  });
});

describe('pattern judgment', () => {
  const fake = (verdict: 'requested' | 'forbidden') => ({ name: 'fake', maxStateTokens: 8000, decide: async () => ({ verdict: { type: 'choice', choice: verdict, confidence: 0.9, probabilities: verdict === 'requested' ? { requested: 0.75, needed: 0.2, unrelated: 0.03, forbidden: 0.02 } : { requested: 0, needed: 0.01, unrelated: 0.02, forbidden: 0.97 } } }) as never });
  it('a force push the task asked for becomes a note; one it did not asks', async () => {
    const asked = new Reflex({ cwd, goal: 'Rewrite history on my feature branch and force push it.', config: { ...defaultConfig, mode: 'enforce', judgePatterns: true }, provider: fake('requested'), log: () => {} });
    const d1 = await asked.pre(call('Bash', { command: 'git push --force origin feature' }));
    expect(d1.policy.kind).toBe('warn');
    expect(d1.host.action).toBe('allow');
    expect(d1.host.note).toContain('asks for it');
    const not = new Reflex({ cwd, goal: 'Fix a typo. Do not rewrite history.', config: { ...defaultConfig, mode: 'enforce', judgePatterns: true }, provider: fake('forbidden'), log: () => {} });
    const d2 = await not.pre(call('Bash', { command: 'git push --force origin main' }));
    expect(d2.host.action).toBe('ask');
    expect(d2.host.reason).toContain('0.97');
  });
  it('without a model, patterns always ask; reads skip the model unless modelOnReads', async () => {
    const r = new Reflex({ cwd, goal: 'Rewrite history.', config: { ...defaultConfig, mode: 'enforce', judgePatterns: true }, log: () => {} });
    expect((await r.pre(call('Bash', { command: 'git push --force' }))).host.action).toBe('ask');
    let calls = 0;
    const p = { name: 'f', maxStateTokens: 8000, decide: async (_s: string, q: Record<string, unknown>) => { calls++; return Object.fromEntries(Object.keys(q).map((k) => [k, { type: 'boolean', p: 0.1 }])) as never; } };
    const r2 = new Reflex({ cwd, goal: 'g', config: { ...defaultConfig, mode: 'enforce' }, provider: p, log: () => {} });
    await r2.pre(call('Read', { file_path: 'a.ts' }));
    expect(calls).toBe(0);
    await r2.pre(call('Edit', { file_path: 'a.ts', old_string: 'a', new_string: 'b' }));
    expect(calls).toBe(1);
  });
});

describe('read-class output is protected from trim', () => {
  it('keeps a 6 KB grep result and still trims a 20 KB one', async () => {
    const { r } = mk({ mode: 'enforce' });
    const c = call('Bash', { command: 'grep -rn "splash" src/' }); await r.pre(c);
    expect((await r.post(c, { output: 'src/a.ts:12: splash\n'.repeat(300) })).kind).toBe('keep');
    const c2 = call('Bash', { command: 'grep -rn "x" src/' }); await r.pre(c2);
    expect((await r.post(c2, { output: 'src/b.ts:12: x here\n'.repeat(1100) })).kind).toBe('trim');
  });
});

describe('retry after deny is the override', () => {
  it('runs the same read on the immediate retry and learns it', async () => {
    const { r, events } = mk({ mode: 'enforce' });
    const c1 = call('Read', { file_path: 'a.ts' }); await r.pre(c1); await r.post(c1, { output: 'x' });
    const d1 = await r.pre(call('Read', { file_path: 'a.ts' }));
    expect(d1.host.action).toBe('deny');
    expect(d1.host.reason).toContain('call again and it will run');
    const d2 = await r.pre(call('Read', { file_path: 'a.ts' }));
    expect(d2.host.action).toBe('allow');
    expect(events.at(-1)?.forced).toBe(true);
    const d3 = await r.pre(call('Read', { file_path: 'a.ts' }));
    expect(d3.event.suppressed).toBe('learned');
  });
});
