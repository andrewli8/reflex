# Architecture review and recommendation

Reviewed revision 3 of the Reflex plan against the Claude Code hooks reference, a real local transcript corpus, a Node cold-start measurement, and the prior-art projects listed at the end. The plan is sound in its product shape. Three structural changes make it survive production: the daemon becomes a stateless provider server, session state becomes an append-only log instead of a rewritten JSON file, and the decision pipeline gets a fixed order with a per-call correlation key. Everything else is refinement.

## 1. Process model

**Verdict: inline core is right; the daemon should hold only the model, and the session file must be append-only.**

Measured cold start on this machine (Node 26.8.1, `--input-type=module`, stdlib imports, stdin read, sha256): 20 ms wall on each of five runs. A tsup single-file ESM bundle of a few hundred KB adds parse time in the low single-digit milliseconds. Claude Code spawns the hook through a shell, so budget 30–40 ms end to end. The plan's 50 ms target is realistic; keep the bundle dependency-free and avoid top-level `await` of anything network-shaped.

**Concurrency is the real bug.** The hooks reference states "All matching hooks run in parallel," and Claude Code issues parallel tool calls in one assistant turn, so two hook processes for the same session routinely overlap. The claude-discord-presence project hit exactly this: two hooks rewrote one session JSON and produced `"prompts":1}s":1}`. Their temp-file-plus-rename fix makes the file never half-written, but it still loses one process's update (last writer wins). For Reflex that means a dropped `recentActions` entry, which silently disables duplicate and cycle detection. Issue anthropics/claude-code #21533 asking for sequential hooks was closed "not planned," so this will not change on the host side.

Recommendation: **the session file is an append-only JSONL event log, and the trace and the state are the same file.** Each hook appends one line under 4 KB with `O_APPEND` (atomic per write on POSIX local filesystems; Node's `appendFileSync` uses it). State is a fold over the tail: read the last 64 KB, parse lines, take the last 25 actions. There is no read-modify-write and therefore no lock, no rename, no corruption. A mutation-aware duplicate check needs to see both calls, and with a log both are always present. Growth is bounded by reading the tail; the file grows at roughly 400 bytes per call, so a 2,000-call session is under 1 MB. `reflex watch` tails the same file. Session key is `session_id` plus `agent_id` when present, because hooks fire inside subagents with the same session and a subagent's reads must not count as duplicates of the parent's.

**Daemon.** The plan's daemon serves `/pre`, `/post`, `/health` and keeps an in-memory session map. That duplicates the core's code path and makes a dead daemon lose state. Cut it to one job: `decide(state, questions)` over a socket. The hook always runs the full pipeline inline and treats the daemon as a `Provider` implementation. A dead daemon then costs nothing but the model answer for one call.

- **Transport:** no TCP port. Unix domain socket at `~/.reflex/reflex.sock`, named pipe `\\.\pipe\reflex` on Windows. Node's `net.createServer().listen(path)` handles both. No collisions with dev servers on 3000/5173/8080, no other-user access, no macOS firewall prompts, no auth token needed on the wire. Speak newline-delimited JSON, not HTTP. Keep the socket path fixed rather than discovered so the hook does one syscall. macOS limits socket paths to about 104 bytes, so it stays under the home directory, never under a project path. If TCP is ever required, bind `127.0.0.1:0` and write the port to `~/.reflex/daemon.json`; do not write that branch in V0.
- **Probe and stale-socket detection:** the connect is the whole probe, with a 100 ms budget. Connect succeeds → send `{"ping":true}`; `ready` means use it, `loading` means fall back this call and do not respawn. `ECONNREFUSED` → a file exists but nothing listens (killed, rebooted, OOM): unlink, spawn `reflex serve` detached (`stdio: 'ignore'`, `unref()`), fall back this call. `ENOENT` → never started or exited cleanly (the daemon unlinks its socket on idle exit and SIGTERM): spawn, fall back. Connect accepted but no ping reply in 100 ms → alive but wedged: fall back, do not unlink, do not spawn, log `path: fallback`; `reflex doctor` reports the pid so the user can kill it. Hooks never kill processes.
- **Spawn race:** two parallel hooks can both see `ECONNREFUSED` and both spawn. The daemon takes an exclusive create on `~/.reflex/daemon.json` (`O_EXCL`), or fails if the recorded pid answers `process.kill(pid, 0)`; the loser exits immediately. This also covers two Claude Code sessions starting at once.
- **daemon.json:** `{pid, socketPath, startedAt, provider, version}`. Read by `doctor`, `watch` and the spawn lock only, never on the hot path.
- **Lifecycle:** idle exit after 30 minutes without requests. Orphaning is accepted for at most 30 minutes of an idle 2 GB process. Drop the separate `/health` endpoint and the 10 s heartbeat file.

## 2. State and transcript coupling

The hooks reference says the transcript "is written asynchronously and may lag the in-memory conversation." I inspected a real local transcript (10.3 MB, 3,900 lines; the 50 newest sessions average 3.1 MB). Line types present, by count: `attachment` 1,946; tool-call pairs 218 each; `last-prompt` 183; `mode`, `permission-mode`, `atis-latch`, `ai-title`, `agent-name`, `system`, `file-history-snapshot`, `queue-operation`, `cost-state`; and 60 plain `user` lines, of which 20 are `isMeta` and several are slash-command wrappers such as `<command-name>/login</command-name>` and `<local-command-stdout>`. Tool-result user lines carry a top-level `toolUseResult` field. The claude-dev.tools reference confirms `type`, `uuid`, `parentUuid`, `sessionId`, `isMeta`, `isSidechain` and warns that "the exact `type` values evolve with Claude Code versions."

Three consequences. Reading the whole file per hook is out (3 MB parse at a 50 ms budget). The "first user message" is not the first `user` line. The "latest assistant text" may not be in the file yet when PreToolUse fires.

**Narrowest parser** (one file, fixture-tested, tolerant of unknown types):

- Goal: scan from the top until the first line with `type == "user"`, `isMeta` absent, `isSidechain` false, `message.content` a string or a `text` block, and text not starting with `<command-name>`, `<local-command-`, or `<system-reminder>`. Cache the goal and the byte offset in the session log on first sight; never rescan.
- Constraints: the plan's regex applied to that goal plus any later qualifying `user` lines, discovered by reading only bytes appended since the cached offset.
- Plan: last `assistant` line with a `text` block, from the final 64 KB. Accept lag; log `planAge` in lines.
- Ignore every other `type`. A parse failure of any line is skipped, never fatal.

**Other hosts** pass `goal`, `constraints`, and `plan` explicitly in `pre()`, and the core stores them in the session log the first time they appear so later calls may omit them. The AI SDK adapter takes them from the first user message and the last assistant text in `prepareStep`.

## 3. Decision pipeline

Bugs found in the plan's ordering:

1. `neverIntervene` is applied "before any check," so a `neverIntervene: ["Bash"]` entry silences the destructive-pattern ASK. Users will write that entry to stop nudges, not to disable force-push prompts.
2. The rate limit exempts ASK but is applied after the policy, so a burst of model-risk ASKs in `nudge` with `askOnModelRisk` on is uncapped.
3. ASK outcome inference depends on "whether PostToolUse fired," but the reference says PostToolUse fires only on success and `PostToolUseFailure` fires on error. A denied ASK and an executed-then-failed command look identical unless the failure hook is registered.
4. `reflex:force` detection is undefined. The hook only sees `tool_input`.
5. Cache key "state hash + question set" includes `recentActions`, which change every call, so the cache never hits on the pre path.

**Sequence** for `pre(call)`:

1. Load config; read session log tail; derive state (section 2). Any failure here: exit 0, no output.
2. Detect override: `reflex:force` in Bash `description`, in the command as a trailing `# reflex:force` comment, or in any string argument of another tool. Record `forced: true` and return EXECUTE, logging the override signal. Destructive patterns still ASK in `enforce` even when forced.
3. Classify (section 4).
4. Destructive-pattern check on `exec`, `vcs`, `db` classes. Hit: policy output ASK. This precedes `neverIntervene`.
5. `neverIntervene` globs on tool name, file path, or command prefix. Hit: EXECUTE, logged as `suppressed: neverIntervene`.
6. Deterministic waste checks: exact duplicate (signature over last 25, no intervening mutation of the same path), near duplicate, cycle, stuck. Reset the windows on each new user prompt, as Gemini CLI does.
7. Provider call, only if no short-circuit and the class is not `read` with an exact duplicate: one `decide` with the class's question set, `AbortSignal.timeout(800)`. Cache key is `sha256(goal + constraints + proposedAction.summary + questionSetId)` with `recentActions` excluded; recent actions only affect `redundant`, which the deterministic layer covers for the cheap cases. TTL 120 s. Timeout or error: signals `null`.
8. Policy (pure function, as in the plan).
9. Rate limit: count SKIP and REPLAN, and model-risk ASKs, over the last 5 actions in the log. Pattern-ASK is never capped.
10. Mode cap, then append one line with `tool_use_id`, policy output, capped output, signals, path, latency.
11. Emit JSON. ASK maps to `permissionDecision: "ask"` (confirmed present in the reference alongside `allow`, `deny`, `deferToPermissionSystem`).

**ASK outcome inference.** Register `PermissionRequest`, `PostToolUse`, and `PostToolUseFailure` hooks, each appending a one-line event keyed by `tool_use_id`. An ASK whose id has a `PermissionRequest` event and no post or failure event within the session is `denied`. An ASK with no `PermissionRequest` event ran in a mode that auto-decides (`bypassPermissions`); record `auto`. `reflex stats` folds these at read time, so no hook looks forward.

**Timeouts.** Set `timeout: 3` on the PreToolUse hook entry. The reference says a timed-out PreToolUse hook is skipped and does not block, so the host itself is the final fail-open.

## 4. Tool classification

Seven classes, each with a fixed `readOnly` flag and allowed interventions:

| class | Claude Code tools | readOnly | may SKIP | may ASK |
|---|---|---|---|---|
| `read` | Read, Glob, `mcp__*__(get\|read\|list\|fetch\|search)*`, Bash `cat ls head tail wc stat find`, `git status/log/diff/show/branch --list`, `docker ps/images`, `kubectl get/describe` | yes | yes | no |
| `search` | Grep, WebSearch | yes | yes | no |
| `network` | WebFetch, Bash `curl`/`wget`/`http` without `-X POST/PUT/DELETE`, `-d`, `--data`, `-T`, `-F` | yes | yes | no |
| `write` | Edit, Write, MultiEdit, NotebookEdit, Bash `sed -i`, `tee`, `> file`, `cp`, `mv`, `mkdir`, `touch`, `chmod` | no | no | yes |
| `exec` | Bash default, Task, `mcp__*` default, package managers, `docker run/build`, `make`, test runners | no | no | yes |
| `vcs` | Bash `git` except the read subcommands, `gh pr merge`, `gh release` | no | no | yes |
| `db` | Bash `psql mysql sqlite3 mongosh redis-cli prisma migrate`, `mcp__*__(query\|execute\|run_sql\|delete)*`, `mcp__Neon__*` | no | no | yes |

Bash classifier: split on `&&`, `||`, `;`, `|`, and newlines with a small tokenizer that respects quotes; classify each segment; the command's class is the most mutating segment. The two guard blog posts fetched (mikelane, aihero.dev) both use plain regex over the whole string and neither handles compound commands; that is the false negative to avoid. A read-only left side of a pipe stays read-only (`cat x | grep y`). Unknown first word: `exec`, `ambiguous: true`, which enables the `toolClass` choice question on providers with room.

Destructive patterns (always ASK): `git push` with `--force` or `-f` and without `--force-with-lease`; `git reset --hard`; `git clean -f`; `git branch -D`; `git checkout .` and `git restore .`; `rm -r` or `rm -f` with a path outside `cwd` or equal to `.`, `/`, `~`; `DROP|TRUNCATE` and `DELETE FROM` without `WHERE`; `kubectl delete`; `docker system prune`; `--no-verify`; `>` redirect onto a tracked path outside `cwd`. Everything else on a mutating class goes to the model.

## 5. Prior art with sources

- **Claude Code hooks reference** (fetched): PreToolUse returns `allow|deny|ask|deferToPermissionSystem`; PostToolUse cannot block and returns `updatedResponse`, with `updatedMCPToolOutput` for MCP tools; `PostToolUseFailure` and `PermissionRequest` exist; hooks run in parallel and inside subagents with `agent_id`; the transcript lags. Teaches: the three ASK-outcome events, and that an MCP TRIM needs a different output field.
- **mikelane, "Building Guardrails for AI Coding Assistants"** (fetched): four Python hooks under 400 lines, regex matching, blocks `git reset --hard` and `--no-gpg-sign`. Teaches: agents adapt after a reasoned block; regex misses compound commands.
- **aihero.dev, "This Hook Stops Claude Code Running Dangerous Git Commands"** (fetched): blocks all `git push`, `git clean`, `branch -D` with exit 2 and a stderr sentence. Teaches: the block-message wording that makes Claude stop retrying.
- **Gemini CLI `loopDetectionService.ts`** (fetched): `TOOL_CALL_LOOP_THRESHOLD = 5`, cycle length 1–5, content chunks of 50 chars repeated 10 times, LLM check after 30 turns every 5–15 turns at confidence 0.9, reset per prompt. Teaches: reset detection state on each user prompt, which the plan lacks.
- **OpenClaw loop detection** (fetched): `(toolName, argsHash, resultHash)` with volatile fields stripped per tool type; warn, then block batch, then end run; off by default. Teaches: hash the result too, so repeated calls with different output count as progress.
- **pi-jev** (fetched): destructive 0.90, exfiltration 0.70, beyond-scope 0.85, damage score 2.5; a requested `sed -i` scores 0.73–0.85 destructive. Teaches: the 0.90 bar exists because ordinary edits score high; state sent is last user message (1,200 chars) plus args (400 chars).
- **jev-guard** (fetched): eight hosts through one hook script that sniffs the payload shape; risk 0–3 with deny at 2.5 and ask at 1.5; 20 s default timeout; fail-open unless `FAIL_CLOSED`. Teaches: one script, payload sniffing, and an intent-verification question close to the plan's `outOfScope`.
- **jev-pruner** (fetched): 20-line chunks, cap 200 chunks, protected classes bypass the model, archive to `.claude/fast-jev-output/` before scoring, failure leaves output untouched. Teaches: archive first, then prune.
- **yoshi** (fetched): proxy judging at 50 K tokens; 34% reduction in one trial, −0.03% in another, latency 40 s to 210 s, three judge failures per trial. Teaches: on-request-path judging of large spans is too slow; per-result admission is the right granularity.
- **awesome-jev** (fetched): also pi-verdict (one choice allow/ask/deny), pi-heed (side effects vs what the user asked), fast-jev-compaction, limpet, jev-belay.
- **TypeSafe docs** (fetched, index and intro only): three primitives, questions "evaluated in parallel and in isolation," "adding questions barely changes the response time." Endpoint, limits and rate limits are not on the public pages; the plan's numbers come from AIMLAPI and OpenRouter and are **not verified here**.
- **LangChain, "Building a harness with Jev"** (fetched): `TypeSafeClassifier`, parallel questions, no fail-open discussion.
- **Laya** (site and `receptron/laya` fetched): 421M ModernBERT-large, 512-token state, 1.7 GB fp32, roughly 2 GB RAM, about 140 ms warm on Apple-silicon CPU, options under 20, no server mode. Confirms the daemon is required for Laya and only Laya.
- **Squeez** (arXiv 2604.04979, fetched abstract): a 2B LoRA pruner removes 92% of tool-output tokens at 0.86 recall. Teaches: whole-result TRIM is the V0 floor; chunk pruning has published headroom.
- **Vercel AI SDK**: `wrapTool(base, {beforeExecute, afterExecute})` is documented in the Vercel Academy harness course (search result only, **not verified**); `toolApproval` with `user-approval` is in the AI SDK 7 changelog (fetched).
- **OpenAI Agents SDK guardrails** (fetched): `defineToolInputGuardrail` returns `allow`, `rejectContent` (message shown to the model), or `throwException`. `rejectContent` is SKIP; there is no `ask`.
- **Concurrency**: claude-discord-presence issue #5 (fetched) and anthropics/claude-code #21533 (fetched, closed "not planned").

## 6. Failure modes

| # | Failure | Mitigation |
|---|---|---|
| 1 | Parallel hooks race on session state | Append-only log; no read-modify-write |
| 2 | Hook adds latency to every Bash call | Deterministic path under 40 ms measured; provider only on mutating or ambiguous calls; 800 ms abort; hook `timeout: 3` |
| 3 | Daemon orphaned or stale socket | Idle exit at 30 min; connect-result probe; spawn lock on daemon.json. Accepted: up to 30 min of an idle 2 GB process |
| 4 | Laya OOM or slow load | Daemon answers `loading` on ping; hook uses fallback; `doctor` shows RAM; Laya is opt-in |
| 5 | ASK fatigue | Pattern-ASK only on the listed commands; model-ASK gated on `outOfScope` and off in `nudge` unless enabled; `stats` shows asks per hour and denied ratio |
| 6 | False SKIP on a legitimate reread | Mutation tracking per path; SKIP only on read classes; `reflex:force`; cap of 2 per 5 steps |
| 7 | Transcript format change | Parser tolerant of unknown `type`; empty goal disables `outOfScope` and logs `goal: missing`; fixtures from three Claude Code versions |
| 8 | Transcript lag hides the latest plan | Accepted; `planAge` logged; plan is advisory in V0 |
| 9 | Compound command evades the classifier | Segment splitting; unknown segments default to `exec`, never `read` |
| 10 | TRIM hides a failure | Error results and `PostToolUseFailure` never trimmed; protected types; original archived before replacement; MCP results use `updatedMCPToolOutput` or are left alone |
| 11 | Subagent calls pollute parent dedupe | State keyed on `session_id + agent_id` |
| 12 | User treats ASK as security | README, `--help`, and every ASK reason carry the same sentence |

## 7. Package and module layout

Three packages confirmed. `daemon.ts` shrinks to `serve.ts`, `session.ts` becomes a log, the adapter handles four hook events.

- `provider.ts`: `Question`, `Answer`, `Provider`, `NoneProvider`. Deps: none.
- `state.ts`: `ControlState`, `normalizeAction`, `serialize` with drop order. Deps: none.
- `transcript.ts`: goal, constraints, plan from a Claude Code JSONL tail; fixtures. Deps: `node:fs`.
- `classify.ts`: class table, bash segmenter, destructive patterns. Deps: none.
- `detect.ts`: signatures, duplicate, near-duplicate, cycle, stuck, mutation tracking, reset on new prompt. Deps: `state`.
- `policy.ts`: pure `pre` and `post` policy, mode cap, rate cap. Deps: none.
- `critic.ts`: orchestration, override detection, cache, abort timeout, event emission. Deps: all above, `provider`.
- `config.ts`: schema, defaults, project then user merge. Deps: `node:fs`.
- `session.ts`: append-only log, tail reader, fold to state, `agent_id` keying. Deps: `node:fs`.
- `stats.ts`: fold of logs into counts, latency, override and ASK outcomes. Deps: `session`.
- `serve.ts`: socket server exposing one `decide`; daemon.json lock; idle exit. Deps: `node:net`, a `Provider`.
- `providers/socket.ts`: `Provider` that connects to `serve.ts`, spawns it on miss. Deps: `node:net`, `node:child_process`.
- `providers/jev.ts`, `providers/llm.ts`: `fetch`-based. Deps: none.
- `replay.ts`, `usefulness.ts`: unchanged.
- `adapters/claude-code.ts`: one entry handling `PreToolUse`, `PostToolUse`, `PostToolUseFailure`, `PermissionRequest` by `hook_event_name`. Deps: `critic`, `session`.
- `adapters/ai-sdk.ts`: `wrapTool` wrapper for the bench. Deps: peer `ai`.
- `cli.ts`: `init | serve | replay | watch | stats | doctor`.
- `@reflex/laya`: implements `Provider` over `@receptron/laya`; run by `serve.ts`.
- `bench`: unchanged.

## ASCII architecture diagram

```text
 Claude Code ─── PreToolUse / PostToolUse / PostToolUseFailure / PermissionRequest
      │  stdin JSON (session_id, agent_id?, tool_use_id, tool_name, tool_input, transcript_path)
      ▼
 ┌── hook process (node, ~30 ms cold) ──────────────────────────────────────────┐
 │ adapters/claude-code.ts                                                       │
 │   │                                                                           │
 │   ├─ session.ts ──── read last 64 KB ──▶ ~/.reflex/sessions/<sid>[.<agent>].jsonl
 │   │                  append 1 line  ──▶ (same file: state + trace, O_APPEND)  │
 │   ├─ transcript.ts ─ goal/constraints (cached offset), plan (tail) ◀─ transcript_path
 │   │                                                                           │
 │   └─ critic.ts                                                                │
 │        override? → classify → destructive ASK → neverIntervene → dup/cycle    │
 │        → provider.decide (cache 120 s, abort 800 ms) → policy → rate cap      │
 │        → mode cap → append event → stdout JSON                                │
 │              │                                                                │
 │              ▼ Provider                                                       │
 │      none | jev (fetch) | llm (fetch) | socket ──┐                            │
 └─────────────────────────────────────────────────┼────────────────────────────┘
                                                   │ NDJSON over ~/.reflex/reflex.sock
                                                   ▼          (named pipe on Windows)
                                       ┌─ reflex serve (detached, idle-exit 30 min) ─┐
                                       │ @reflex/laya: ONNX resident, decide() only  │
                                       │ no session state, no HTTP, daemon.json lock │
                                       └─────────────────────────────────────────────┘

 reflex watch / stats / replay  ──── fold the same per-session logs; replay feeds
                                     transcripts through critic.ts with mode=shadow
```

## Changes to the plan

- **§4 Core library, §5 daemon row, §8 steps 1–2, §10 last paragraph**: the daemon exposes only `decide`; the pipeline always runs inline. Removes the duplicated `/pre` `/post` path and the in-memory session map. A dead daemon then loses nothing, and there is one code path to test.
- **§4 Core library, §13 `session.ts`**: replace "atomic rename, one file per session" with an append-only JSONL log that is also the trace; state is a fold of the tail. Hooks run in parallel and rename loses writes.
- **§5 Health and failure**: drop `/health`, the heartbeat file, and HTTP; the socket connect is the probe; Unix socket at `~/.reflex/reflex.sock` or named pipe; `daemon.json` as spawn lock and pid record.
- **§5 Not blocking good work, §9 rules**: move `neverIntervene` after the destructive-pattern check. Users use it to silence nudges, not to disable force-push prompts.
- **§4 Telemetry, §8 step 10**: register `PostToolUseFailure` and `PermissionRequest` hooks; ASK outcome is inferred from the three events per `tool_use_id`. PostToolUse fires only on success, so absence alone cannot distinguish denied from failed.
- **§7 Control state**: add `transcript.ts` rules from section 2; cache goal and byte offset; key state on `session_id + agent_id`; reset dedupe windows on each new user prompt. Transcripts average 3 MB and contain many non-conversation line types.
- **§8 step 6**: cache key excludes `recentActions`. The current key never hits.
- **§8 step 4, §17 item 3**: bash classifier segments compound commands; add `--force-with-lease` exemption, `git branch -D`, `kubectl delete`, `docker system prune`, `--no-verify`. Regex over the whole string misses `a && rm -rf x`.
- **§8 step 14**: MCP tool results are replaced through `updatedMCPToolOutput`, not `updatedResponse`.
- **§4 Claude Code adapter**: hook `timeout: 3` rather than 2, and note that a timed-out PreToolUse is skipped by the host.
- **§9 rate limit**: count model-risk ASKs in the cap; pattern ASKs stay exempt. Uncapped model ASKs in nudge mode are the fatigue path.
- **§13**: add `transcript.ts`, `providers/socket.ts`; rename `daemon.ts` to `serve.ts`.
- **§16 criterion 11**: keep 50 ms; measured baseline is 20 ms for stdlib ESM on this machine.
- **§3 Jev row**: mark endpoint, 32K state and rate limits as unverified against docs.typesafe.ai public pages.

## Sources

- https://code.claude.com/docs/en/hooks
- https://claude-dev.tools/docs/jsonl-format
- https://dev.to/mikelane/building-guardrails-for-ai-coding-assistants-a-pretooluse-hook-system-for-claude-code-ilj
- https://www.aihero.dev/this-hook-stops-claude-code-running-dangerous-git-commands
- https://github.com/gabrielhom/claude-discord-presence/issues/5
- https://github.com/anthropics/claude-code/issues/21533
- https://github.com/google-gemini/gemini-cli/blob/main/packages/core/src/services/loopDetectionService.ts
- https://docs.openclaw.ai/tools/loop-detection
- https://github.com/yibie/awesome-jev
- https://github.com/y0usaf/pi-jev
- https://github.com/leepokai/jev-guard
- https://github.com/tamaratran/jev-pruner
- https://github.com/compozy/yoshi
- https://docs.typesafe.ai and https://docs.typesafe.ai/llms.txt
- https://www.langchain.com/blog/building-a-harness-with-jev
- https://laya.convaiinnovations.com/
- https://github.com/receptron/laya
- https://arxiv.org/abs/2604.04979
- https://ai-sdk.dev/docs/ai-sdk-core/tools-and-tool-calling
- https://vercel.com/changelog/ai-sdk-7
- https://openai.github.io/openai-agents-js/guides/guardrails/
- Local: `~/.claude/projects/*/*.jsonl` inspection; Node 26.8.1 cold-start timing
