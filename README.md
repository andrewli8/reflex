# Reflex

Judgment for coding agents, in 200 ms. Reflex asks Jev, a small typed decision model, three questions your agent's permission system cannot answer: does this destructive command belong to the task, does this edit break a constraint I stated, and does the next step need the big model.

Works with Claude Code, Codex and the Vercel AI SDK.

## What Jev decides

Your permission rules match command strings. They cannot know that a force push is fine on "squash and push my branch" and wrong on "fix the typo, do not rewrite history", or that editing `auth0.config.ts` violates "do not change authentication providers". Reflex hands Jev the task, the constraints, the last few actions and the proposed call, and acts on the answer.

```text
Bash git push --force origin feature   task: squash and force push it        [reflex] the task asks for it (1.00), proceeding
Bash git push --force origin main      task: fix the typo, do not rewrite     [reflex] ask: forbidden by the task (1.00)
Bash ./sync.sh                         script hides git reset --hard          [reflex] ask: unrelated to the task (0.90)
Edit auth0.config.ts → Clerk           constraint: do not change providers    [reflex] ask: conflicts with a constraint (0.99)
Edit auth.ts "/hom" → "/home"                                                 [reflex] in scope (0.20), proceeding
```

Every line above came from the shipped hook, not a demo script. The agent's own permission prompt still decides; Reflex only tells it when to appear.

## Numbers

Measured, not estimated. Details and the scripts are in `docs/PLAN.md`.

| what | result |
|---|---|
| destructive commands judged against the task (four contexts, Jev) | requested 0.75, needed 0.70, unrelated 0.97, forbidden 0.99: all four correct |
| constraint-violating edit vs in-scope edit, through the real hook | 0.99 asked, 0.20 allowed |
| planted trap: script that force-pushes, task says do not rewrite history | agent ran it; Reflex stopped it (`docs/evidence/`) |
| 39-step task on Sonnet 5, `ultra`: Jev routes routine steps to Haiku | $1.75 became $0.28, same outcome |
| same task, collapse of unreferenced results | 716,862 input tokens became 266,982 |
| Jev cost | about $0.02 per 1,000 tool calls |

## See it

`apps/demo/terminal.html` shows the pipeline inline in a terminal replay: each tool call, then the Reflex line lighting up classify, dedupe, script scan, Jev with its score and latency, and the decision. `apps/demo/story.html` is the cinematic version: six beats, one tool call each, autoplaying and looping. `apps/demo/flow.html` plays the two sessions as a flow: packets are tool calls, the tank is what the model re-reads every step. `apps/demo/infographic.html` is the one-page summary (`infographic.png` beside it). `apps/demo/index.html` replays the real benchmark trace step by step.

## How it works

Reflex is a hook that runs before and after every tool call. Cheap checks find candidates: a destructive command, including one hidden inside a script the agent invokes; a write; an oversized result. Jev judges the candidate against your task in one round trip of 130 to 500 ms, and a fixed policy turns the score into allow, note, ask or deny. If Jev is slow or unreachable, the call proceeds after 1.5 s. Your permission system remains the boundary.

Also, without a model: your constraints are restated every turn so they never scroll out of attention, the agent gets a ledger of what it already read, edited and verified after each compaction, repeated reads and polling loops are pointed out, and oversized output is trimmed with error lines kept. Useful, but not the reason to install.

## Install

```bash
npm i -g agent-reflex
cd your-project
```

Claude Code:

```bash
reflex init
```

Codex:

```bash
reflex init --codex
```

Both, or user-wide:

```bash
reflex init --all
reflex init --all --global
```

`init` asks for your Jev key (TypeSafe, typesafe.ai), then replays your last 20 sessions and prints what it would have caught. Without a key Reflex runs limited: candidates are found but not judged, and `doctor` says so. Codex asks you to approve the new hook the first time you open it in that project.

Prefer to let the agent do it? Paste `INSTALL-PROMPT.md` into any coding agent, or drop `skills/reflex-install` into `.claude/skills`.

## Commands

| command | what it does |
|---|---|
| `reflex init [--codex] [--all] [--global]` | install the hooks |
| `reflex report` | last 30 days: near misses, polling loops, dead weight, biggest unused sources |
| `reflex replay --last 20` | shadow mode over past sessions, with a usefulness label for every call |
| `reflex stats` | decisions, latency, overrides, ask outcomes |
| `reflex watch` | live view of the current session |
| `reflex doctor` | config, keys, daemon, hook state |
| `reflex key jev <key>` | store a decision-model key for hooks that lack your shell env |
| `reflex clean --older-than 30d` | delete old logs and archives |

## Levels

One knob. `reflex level <name>` writes it to `reflex.config.json` (`--global` for `~/.reflex/config.json`).

| level | what Reflex does | risky calls |
|---|---|---|
| `off` | nothing; hooks stay installed | agent decides |
| `watch` | logs only, so `report` and `replay` work | agent decides |
| `ask` (default) | Jev judges destructive commands and edits against your task; you get a prompt only when the task did not call for it | your prompt, when it matters |
| `auto` | unattended: what would have prompted is denied with a reason, so the agent routes around it | denied |
| `ultra` | `auto` plus Jev on reads, token-first trim, and per-step model routing on the AI SDK | denied |

Use `auto` or `ultra` for CI and overnight runs, where a prompt would hang forever. Any key in the config file still overrides its level's preset; `mode: "nudge"` is still available for note-only behaviour.

A denied call can be re-issued with `reflex:force` in its description. Reflex stops nudging a pattern once you override it. At most two interventions per five steps.

## Decision models

Jev is the default. The others exist for comparison and for people who cannot use a hosted model.

| provider | what | needs |
|---|---|---|
| `jev` (default) | TypeSafe's hosted decision model, 130 to 500 ms, about $0.02 per 1,000 calls | `reflex key jev <key>` |
| `none` | candidates only, no judgment | nothing |
| `laya` | open-source local model, 290 ms per question on a laptop | 1.7 GB download, runs in a small daemon |
| `llm` | Claude Haiku answering the same questions | `ANTHROPIC_API_KEY` |

What Jev is not asked outside `ultra`: whether a read will turn out useful. We measured that at coin-flip quality on 420 labelled reads and say so.

## AI SDK

```ts
import { Reflex, withReflex, reflexPrepareStep } from 'agent-reflex';

const reflex = new Reflex({ cwd: process.cwd(), goal: task });
await generateText({
  model, prompt: task,
  tools: withReflex(tools, reflex, { classes: { readFile: 'read', runSql: 'db' } }),
  prepareStep: reflexPrepareStep(reflex, { after: 5, checkpointEvery: 10 }),
  stopWhen: stepCountIs(60),
});
```

Tool results nothing referenced collapse to one line at each checkpoint. That is where the 63% comes from.

With `level: ultra` and `routing: { small, large }` passed to `reflexPrepareStep`, Jev decides before each step whether the next action is routine (read, list, run tests, one-line edit) or reasoning (design a change, debug, multi-file edit) and picks the model accordingly. It only routes down on a confident verdict; any doubt or failure stays on the large model. Measured on the benchmark task with Sonnet 5 as the large model: $1.75 to $0.28 with the task still completed. That task is mostly routine steps, so it shows routing down well and routing back up hardly at all; expect a smaller saving on design-heavy work.

## FAQ

**Is this a security tool?** No. It advises the agent's permission system. Sandboxing, allowlists and permissions stay where they are.

**Does it slow the agent down?** The hook starts in about 30 ms. A decision model adds 130 to 500 ms on the calls that reach it, which you can limit with `modelClasses`.

**What does it store?** Session logs and archived tool output under `~/.reflex`, owner-only permissions, with API keys, bearer tokens and `KEY=value` secrets redacted before they are written. Redaction is pattern based: it catches labelled values and common token formats, and it will miss an unlabelled or unusually formatted secret, so treat it as a safety net rather than a guarantee. Nothing leaves your machine unless you configure a hosted model.

**What does a hosted model see?** With `jev` or `llm` configured, each judged call sends a text state under a few hundred tokens: your task's first prompt and latest prompt, the extracted constraints, the last eight tool calls as one-line summaries with 80-character result digests, and the proposed call. The same redaction runs on that text first. Full tool outputs and file contents are never sent.

**Can tool output manipulate the agent through Reflex?** The ledger and notes re-inject short, labelled digests of earlier results, never full output. Treat them like any other tool result: they carry no more authority than the text they summarize.

**Where are the caveats?** `docs/PLAN.md` has every measurement, including the ones that did not work.

## License

MIT
