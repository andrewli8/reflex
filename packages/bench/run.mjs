// Live AI SDK benchmark: same task, same model, with and without Reflex collapse. Reports input tokens per arm.
import { generateText, stepCountIs, tool } from 'ai';
import { z } from 'zod';
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execSync } from 'node:child_process';
import { Reflex, withReflex, reflexPrepareStep, jevProvider } from 'agent-reflex';

const MODEL = process.env.BENCH_MODEL ?? 'anthropic/claude-haiku-4-5';
const ARMS = (process.env.BENCH_ARMS ?? 'baseline,reflex').split(',');
const LARGE = process.env.BENCH_LARGE ?? 'anthropic/claude-sonnet-5';
const SMALL = process.env.BENCH_SMALL ?? 'anthropic/claude-haiku-4-5';
const PRICE = { 'anthropic/claude-sonnet-5': [2, 10], 'anthropic/claude-haiku-4-5': [1, 5], 'anthropic/claude-opus-5': [5, 25] };
const DOCS = Number(process.env.BENCH_DOCS ?? 30);
const REPEATS = Number(process.env.BENCH_REPEATS ?? 2);

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'reflex-bench-'));
  mkdirSync(join(dir, 'docs')); mkdirSync(join(dir, 'src'));
  for (let i = 1; i <= DOCS; i++) writeFileSync(join(dir, 'docs', `module${i}.md`), `# Module ${i}\n\n` + Array.from({ length: 60 }, (_, j) => `- setting_${i}_${j}: ${j % 7 === 0 ? 'enabled' : 'disabled'} (owner team-${(i * j) % 5})`).join('\n'));
  writeFileSync(join(dir, 'src', 'auth.ts'), 'export const login = (req) => redirect(req.query.next_url ?? "/hom");\nexport const REDIRECT_DEFAULT = "/hom";\n');
  writeFileSync(join(dir, 'src', 'routes.ts'), 'import { login } from "./auth";\nexport const routes = { "/login": login };\n');
  return dir;
}

function tools(dir) {
  const safe = (p) => join(dir, p.replace(/^\/+/, ''));
  return {
    read_file: tool({ description: 'Read a file', inputSchema: z.object({ path: z.string() }), execute: async ({ path }) => { try { return readFileSync(safe(path), 'utf8'); } catch (e) { return `ERROR: ${e.message}`; } } }),
    list_files: tool({ description: 'List files under a directory', inputSchema: z.object({ path: z.string().default('.') }), execute: async ({ path }) => { try { return execSync(`find ${JSON.stringify(safe(path))} -type f | sed "s#${dir}/##"`).toString(); } catch (e) { return `ERROR: ${e.message}`; } } }),
    write_file: tool({ description: 'Write a file', inputSchema: z.object({ path: z.string(), content: z.string() }), execute: async ({ path, content }) => { writeFileSync(safe(path), content); return `wrote ${path}`; } }),
    bash: tool({ description: 'Run a shell command in the repo', inputSchema: z.object({ command: z.string() }), execute: async ({ command }) => { try { return execSync(command, { cwd: dir, timeout: 20000 }).toString().slice(0, 20000) || '(no output)'; } catch (e) { return `ERROR: ${(e.stdout ?? '').toString().slice(0, 2000)} ${(e.stderr ?? '').toString().slice(0, 2000)}`; } } }),
  };
}

const TASK = `You are working in a small repo with ${DOCS} files under docs/. Work strictly one tool call per turn, never parallel calls. Phase 1: list docs/, then read each docs file in its own turn and keep a running tally of how many settings are enabled per module; after the last file write docs/INDEX.md with one line per module. Phase 2: read src/routes.ts, read src/auth.ts, fix the misspelled default redirect path to /home in both places using write_file, run \`grep -n hom src/auth.ts\` to verify, then run \`cat docs/INDEX.md | wc -l\`. Reply "done" when finished.`;

async function run(arm) {
  const dir = fixture();
  const base = tools(dir);
  // arms: baseline (MODEL alone) | reflex (collapse) | route (collapse + Jev picks SMALL or LARGE per step, run starts on LARGE)
  const routing = arm === 'route';
  const reflex = new Reflex({ cwd: dir, goal: TASK, config: { mode: 'enforce', routing: { enabled: routing } }, ...(routing ? { provider: jevProvider() } : {}) });
  const t0 = Date.now();
  const model = routing ? LARGE : MODEL;
  const opts = {
    model, prompt: TASK, stopWhen: stepCountIs(80),
    tools: arm === 'baseline' ? base : withReflex(base, reflex, { classes: { read_file: 'read', list_files: 'read', write_file: 'write', bash: 'exec' } }),
    ...(arm === 'baseline' ? {} : { prepareStep: reflexPrepareStep(reflex, { after: 3, checkpointEvery: 5, ...(routing ? { routing: { small: SMALL, large: LARGE } } : {}) }) }),
  };
  const events = [];
  const r = await generateText(opts);
  const steps = r.steps.length;
  // Per-step trace for the demo: what was called, how big the result was, what the model paid to read.
  const trace = r.steps.map((s, i) => ({
    step: i + 1,
    model: s.response?.modelId ?? '',
    input: s.usage?.inputTokens ?? 0,
    output: s.usage?.outputTokens ?? 0,
    calls: (s.toolCalls ?? []).map((c) => ({ tool: c.toolName, arg: String(Object.values(c.input ?? {})[0] ?? '').slice(0, 60) })),
    resultBytes: (s.toolResults ?? []).reduce((a, t) => a + JSON.stringify(t.output ?? '').length, 0),
    collapsed: (s.toolResults ?? []).filter((t) => String(t.output ?? '').includes('[reflex]')).length,
  }));
  const input = r.steps.reduce((a, s) => a + (s.usage?.inputTokens ?? 0), 0);
  const cached = r.steps.reduce((a, s) => a + (s.usage?.cachedInputTokens ?? s.usage?.inputTokenDetails?.cacheReadTokens ?? 0), 0);
  const output = r.steps.reduce((a, s) => a + (s.usage?.outputTokens ?? 0), 0);
  const fixed = /"\/home"/.test(readFileSync(join(dir, 'src', 'auth.ts'), 'utf8')) && !/"\/hom"/.test(readFileSync(join(dir, 'src', 'auth.ts'), 'utf8'));
  const index = (() => { try { return readFileSync(join(dir, 'docs', 'INDEX.md'), 'utf8').length; } catch { return 0; } })();
  const cost = r.steps.reduce((a, s) => { const id = 'anthropic/' + String(s.response?.modelId ?? '').replace(/^anthropic\//, ''); const p = PRICE[id] ?? PRICE[model] ?? [0, 0]; return a + ((s.usage?.inputTokens ?? 0) * p[0] + (s.usage?.outputTokens ?? 0) * p[1]) / 1e6; }, 0);
  const smallSteps = r.steps.filter((s) => String(s.response?.modelId ?? '').includes('haiku')).length;
  return { arm, model, steps, smallSteps, input, cached, output, costUsd: Math.round(cost * 10000) / 10000, seconds: Math.round((Date.now() - t0) / 1000), fixed, indexBytes: index, finish: r.finishReason, trace };
}

const results = [];
for (let i = 0; i < REPEATS; i++) for (const arm of ARMS) { try { results.push(await run(arm)); } catch (e) { results.push({ arm, error: String(e.message ?? e).slice(0, 300) }); } }
const mean = (arm, k) => { const xs = results.filter((r) => r.arm === arm && !r.error).map((r) => r[k]); return xs.length ? Math.round(xs.reduce((a, b) => a + b, 0) / xs.length) : null; };
mkdirSync('results', { recursive: true });
writeFileSync('results/latest.json', JSON.stringify({ model: MODEL, docs: DOCS, repeats: REPEATS, results }, null, 1));
console.log(JSON.stringify({ model: MODEL, docs: DOCS, repeats: REPEATS, results: results.map(({ trace, ...r }) => r), means: Object.fromEntries(ARMS.map((a) => [a, { steps: mean(a, 'steps'), smallSteps: mean(a, 'smallSteps'), input: mean(a, 'input'), output: mean(a, 'output'), costUsd: (() => { const xs = results.filter((r) => r.arm === a && !r.error).map((r) => r.costUsd); return xs.length ? Math.round((xs.reduce((p, q) => p + q, 0) / xs.length) * 10000) / 10000 : null; })(), seconds: mean(a, 'seconds'), fixed: results.filter((r) => r.arm === a && r.fixed).length }])) }, null, 2));
