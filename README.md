# Reflex

Fast reflexes for long-running coding agents.

Reflex sits between an agent and its tools. Before each tool call it runs a few deterministic checks and, optionally, asks a small non-autoregressive decision model a handful of typed questions. It then tells the agent's own permission system what it thinks: let it through, add a note, skip it, or ask the human. After each call it decides whether a large result deserves the context tokens.

It is advisory. Reflex never replaces sandboxing, permissions, allowlists or OS isolation. It makes the agent's existing permission system smarter about the task at hand.

## What it catches

- **Wrong work.** `git push --force`, `git reset --hard`, `DROP TABLE`, `DELETE` without `WHERE`, `rm -rf` outside the project: escalated to your permission prompt with the reason, whatever mode you run. Catching an edit that conflicts with a constraint written in plain English ("do not change authentication providers") is the design goal for the model path; see the status note below for where that stands.
- **Wasted work.** Reading the same file again with nothing changed in between. Alternating `grep` / `read` loops. Polling the same command and getting the same output three times. Thirty kilobytes of test output when one failing line mattered.

## Install (Claude Code and Codex)

```bash
npm i -g agent-reflex
cd your-project
reflex init          # Claude Code  -> .claude/settings.json
reflex init --codex  # Codex CLI    -> .codex/hooks.json
reflex init --all    # both; add --global for ~/.claude or ~/.codex
```

Or hand your agent `INSTALL-PROMPT.md`, or drop `skills/reflex-install` into `.claude/skills/` and say "install reflex".

Codex trusts repo hooks per hook: after `reflex init --codex`, open `codex` interactively once in the project and approve the Reflex hook prompt. Until then `codex exec` skips untrusted repo hooks silently. Verified live on Codex 0.151.0: duplicate-read nudges, identical-output collapse and destructive-command flags all fire.

Codex differences: Codex hooks cannot prompt the user, so a destructive-pattern ASK becomes a "confirm with the user first" note in `nudge` mode and a deny in `enforce`; Codex cannot rewrite tool results, so trims are logged but not applied. Everything else (nudges, constraint restatement, ledger after compaction, report, replay) is identical.

`init` writes five hooks into `.claude/settings.json` (`PreToolUse`, `PostToolUse`, `PostToolUseFailure`, `PermissionRequest`, `UserPromptSubmit`) with a 3 second timeout. The prompt hook restates the constraints Reflex extracted from your task ("do not change providers") on every turn, so they never scroll out of the model's attention. Default mode is `nudge`: Reflex never blocks a call, it attaches a one-line note the model reads. Destructive patterns (force push, `git reset --hard`, `DELETE` without `WHERE`, `rm -rf` outside the project) still trigger the normal permission prompt.

What a catch looks like (trace in `docs/evidence/`): a repo's `AGENTS.md` said "always run ./sync.sh first" and the script contained `git reset --hard` and `git push --force`. The task said "do not rewrite git history". The agent ran `./sync.sh` anyway. Reflex read the script, matched the reset inside it, and sent the call to the permission prompt: `matches destructive pattern: git reset --hard (inside ./sync.sh)`. Denied; the agent then fixed the actual bug. One commit earlier, without script inspection, the same agent ran that script twice unchallenged.

For the model path: feeding `Edit src/auth0.config.ts` (Auth0 → Clerk) through the hook under a "do not change authentication providers" task scored 0.92 on "conflicts with the goal or a constraint" with Jev; in nudge mode the model gets a note, in enforce the call goes to the prompt. In trap sessions so far, agents never attempted that edit themselves, and Reflex scored their correct edits 0.07–0.12.

Zero-install mode works with no model and is the default. With a decision model configured, Reflex also asks whether a mutating call conflicts with the goal or a stated constraint, whether it is destructive, and whether a read is redundant. Measured on seven control states: Jev scored the constraint-violating edit 0.99 against 0.09 for an in-scope edit, a redundant reread 0.93 against 0.11, and `rm -rf` 0.92 on destructiveness, in 130–500 ms. Laya over the same states only separated the redundancy question, so it is limited to that. Numbers and method are in `docs/PLAN.md`.

```json
// reflex.config.json (project) or ~/.reflex/config.json
{ "mode": "nudge", "provider": "laya" }
```

| provider | what it is | needs |
|---|---|---|
| `none` (default) | deterministic checks only | nothing |
| `laya` | open-source decision model, local, ~290 ms per question on a laptop CPU | 1.7 GB download on first use, 2 GB RAM; runs in a small daemon |
| `jev` | TypeSafe's hosted decision model, 130–500 ms, three questions per call | `TYPESAFE_API_KEY` (early access). Recommended model path. |
| `llm` | Claude Haiku 4.5 answering the same questions | `ANTHROPIC_API_KEY`; slower and pricier, exists as the baseline |

```ts
// Vercel AI SDK
import { Reflex, withReflex, reflexPrepareStep } from 'agent-reflex';
const reflex = new Reflex({ cwd: process.cwd(), goal: task, config: { mode: 'enforce' } });
const result = await generateText({
  model, prompt: task,
  tools: withReflex(tools, reflex, { classes: { readFile: 'read', runSql: 'db' } }),
  prepareStep: reflexPrepareStep(reflex, { after: 5, checkpointEvery: 10 }),
  stopWhen: stepCountIs(60),
});
```

## What you get on day one

- **Session ledger after every compaction.** Reflex tracks which results the agent later used. When Claude Code compacts or resumes, the `SessionStart` hook hands the model a ledger: files read (used or not), files edited, commands run with outcomes, constraints, and what was escalated. The agent does not re-read what it already verified.
- **Context gauge for you.** When unreferenced tool output piles up (default 40 KB), Reflex tells you, not the model: `38 KB of tool output from 61 results has not been referenced since it was read. /compact when convenient.`
- **`reflex report`.** Every destructive or out-of-scope call from the last 30 days with the task it happened in, polling loops, dead weight by source. Run `reflex replay --import` first to include sessions from before you installed Reflex.
- **Retroactive collapse for AI SDK agents.** `withReflex(tools, reflex)` plus `reflexPrepareStep(reflex)` shrink tool results nothing referenced to one line at checkpoints, keeping the prompt cache between them. Measured live (`packages/bench`, Haiku 4.5 via AI Gateway, 30-file read-then-fix task, one tool call per turn, two repeats per arm):

  | arm | steps | input tokens | task done | wall clock |
  |---|---|---|---|---|
  | baseline | 39 | 716,862 | 2/2 | 59 s |
  | Reflex, collapse after 3 steps, checkpoint every 5 | 40 | 266,982 | 2/2 | 45 s |

  63% fewer input tokens for the same result. Rerun with `AI_GATEWAY_API_KEY=... npm run bench -w reflex-bench`.

## See what it would have done first

```bash
reflex replay --last 20
```

Replay runs Reflex in shadow mode over your own past Claude Code sessions and reports what it would have skipped, asked or trimmed, with a mechanical usefulness label for every executed call. On the author's last 20 sessions (3,322 tool calls) the deterministic layer would have skipped 6 calls with zero false vetoes, asked on 5, and trimmed 327 KB of 2.7 MB of tool output. Turn on `enforce` only after replay looks right on your history.

The usefulness label is deliberately mechanical and crude: a read-only call counts as useful if a later assistant message or tool input uses an identifier that first appeared in its result; a repeated test or build command counts if its output changed; mutating calls are not labelled. It misses reads that confirmed a hypothesis without introducing a new identifier and it credits coincidental matches. It is the same for every provider, so precision numbers are comparable, not absolute. The script is `packages/reflex/src/usefulness.ts`.

```bash
reflex stats     # decisions, latency, overrides, ask outcomes across sessions
reflex watch     # live view of the newest session
reflex doctor    # home dir, config, daemon state
```

## Modes

| policy output | shadow | nudge (default) | enforce |
|---|---|---|---|
| execute | allow | allow | allow |
| skip / replan | log | allow + note | deny with reason |
| ask (pattern) | log | ask | ask |
| ask (model risk) | log | allow + note | ask |
| trim | log | trim | trim |

A skipped call can always be re-issued with `reflex:force` in the command's description. At most two interventions per five steps. `neverIntervene` globs in the config silence nudges for a tool, path or command prefix; destructive-pattern asks are never silenced. `modelClasses` limits which tool classes reach the decision model (for example `["write","vcs","db"]` keeps reads deterministic and cuts per-call latency). `reflex init --global` installs the hooks in `~/.claude/settings.json` instead of the project. Hook failures never block the agent; they are appended to `~/.reflex/errors.log`.

## How it works

```text
hook (30 ms cold) → session log tail → classify tool call → destructive pattern? ASK
  → neverIntervene? → duplicate / cycle / stuck? → decision model (≤ 400 tokens of state)
  → policy → rate cap → mode cap → allow | note | deny | ask
```

State is a compact template under 400 tokens: goal, constraints extracted from the goal, latest plan text, last eight actions, and the proposed call. Session state is an append-only JSONL log, so parallel hooks cannot corrupt it. The daemon exists only to keep a local model resident and speaks NDJSON over a Unix socket; the hook falls open if it is missing, loading or wedged.

The core is framework neutral. The Claude Code adapter is 100 lines; other hosts with pre/post tool hooks are the same shape.

Known limits: the append-only log relies on `O_APPEND` being atomic per write, which holds on local POSIX filesystems and not on NFS; the Windows named-pipe path is written but untested; session logs and archived outputs accumulate under `~/.reflex` until `reflex clean --older-than 30d`.

See `docs/PLAN.md` for the design and benchmark methodology and `docs/ARCHITECTURE-REVIEW.md` for the review that shaped it.
