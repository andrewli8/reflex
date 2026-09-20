# Reflex

Fast reflexes for coding agents. It watches every tool call, stops the dumb ones, and forgets what the agent no longer needs.

Works with Claude Code and Codex. One install, no model required.

## Before / after

Your agent reads `auth.ts`. Then it reads `auth.ts` again. Then it runs the test suite and pastes 30 KB of output into its own context, where every later step pays to re-read it. Twenty minutes in, it forgets you said "do not change authentication providers" and starts a migration. Somewhere in there it runs a setup script that force-pushes.

With Reflex:

```text
Read auth.ts                       ok
Read auth.ts                       [reflex] identical call already made at step 1
Bash npm test                      [reflex] trimmed 2,400 lines, 3 error lines kept, full output archived
Bash ./sync.sh                     [reflex] ask: git reset --hard (inside ./sync.sh)
Edit auth0.config.ts               [reflex] conflicts with a constraint: do not change authentication providers
```

The agent's own permission prompt still decides. Reflex only advises it.

## Numbers

Measured, not estimated. Details and the scripts are in `docs/PLAN.md`.

| what | result |
|---|---|
| 39-step agent task, Haiku 4.5, with and without Reflex collapse | 716,862 input tokens became 266,982 (63% fewer), same outcome, 14 s faster |
| 20 real Claude Code sessions, replayed | 6 destructive commands sent to the prompt, 0 false vetoes, 25% of tool output never used again |
| planted trap: script that force-pushes, task says do not rewrite history | agent ran it; Reflex read the script and stopped it (`docs/evidence/`) |

## See it

`apps/demo/flow.html` plays the two sessions as a flow: packets are tool calls, the tank is what the model re-reads every step. `apps/demo/infographic.html` is the one-page summary (`infographic.png` beside it). `apps/demo/index.html` replays the real benchmark trace step by step.

## How it works

Reflex is a hook. Before a tool call it classifies the call, checks it against what already happened, and returns one of: let it through, add a note, skip it, or ask you. After the call it decides whether the output deserves the context it will occupy.

Most of that is deterministic: hashes, cycle detection, a list of destructive patterns, a look inside any local script the agent runs. The parts that need judgment (is this edit against the user's constraint?) can go to a decision model, if you turn one on.

Two things happen every turn without a model. Your task's constraints are restated so they never scroll out of attention. After a compaction, the agent gets a ledger of what it already read, edited, ran and verified, so it does not start over.

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

`init` finishes by replaying your last 20 sessions and printing what it would have caught. Codex asks you to approve the new hook the first time you open it in that project.

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

## Modes

Default is `nudge`. Reflex never blocks a call in that mode. It attaches a one-line note the model reads, and destructive commands go to your normal permission prompt.

```json
// reflex.config.json
{ "mode": "nudge", "provider": "none" }
```

| mode | duplicate read | destructive command | oversized output |
|---|---|---|---|
| shadow | logged | logged | logged |
| nudge | note to the model | permission prompt | trimmed, original archived |
| enforce | denied with a reason | permission prompt | trimmed, original archived |

A denied call can be re-issued with `reflex:force` in its description. Reflex stops nudging a pattern once you override it. At most two interventions per five steps.

## Decision models

Optional. Without one, everything above still works.

| provider | what | needs |
|---|---|---|
| `none` | deterministic checks only | nothing |
| `jev` | TypeSafe's hosted decision model, 130 to 500 ms | `reflex key jev <key>` |
| `laya` | open-source local model, 290 ms per question on a laptop | 1.7 GB download, runs in a small daemon |
| `llm` | Claude Haiku answering the same questions | `ANTHROPIC_API_KEY` |

What a model adds today: it scores whether a mutating call conflicts with your stated constraints (a constraint-violating edit scored 0.99 against 0.09 for an in-scope one). What it does not add: predicting which reads will turn out useless. We measured that at coin-flip quality and say so.

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

## FAQ

**Is this a security tool?** No. It advises the agent's permission system. Sandboxing, allowlists and permissions stay where they are.

**Does it slow the agent down?** The hook starts in about 30 ms. A decision model adds 130 to 500 ms on the calls that reach it, which you can limit with `modelClasses`.

**What does it store?** Session logs and archived tool output under `~/.reflex`, owner-only permissions, with API keys, bearer tokens and `KEY=value` secrets redacted before they are written. Redaction is pattern based: it catches labelled values and common token formats, and it will miss an unlabelled or unusually formatted secret, so treat it as a safety net rather than a guarantee. Nothing leaves your machine unless you configure a hosted model.

**What does a hosted model see?** With `jev` or `llm` configured, each judged call sends a text state under a few hundred tokens: your task's first prompt and latest prompt, the extracted constraints, the last eight tool calls as one-line summaries with 80-character result digests, and the proposed call. The same redaction runs on that text first. Full tool outputs and file contents are never sent.

**Can tool output manipulate the agent through Reflex?** The ledger and notes re-inject short, labelled digests of earlier results, never full output. Treat them like any other tool result: they carry no more authority than the text they summarize.

**Where are the caveats?** `docs/PLAN.md` has every measurement, including the ones that did not work.

## License

MIT
