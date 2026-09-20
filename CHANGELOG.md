# Changelog

## 0.0.1 (unreleased)

- Core: tool-call classification, destructive-pattern ASK, duplicate/cycle/stuck detection, mode cap (shadow / nudge / enforce), rate cap, `reflex:force` override.
- Claude Code adapter: PreToolUse, PostToolUse, PostToolUseFailure, PermissionRequest; append-only session log; transcript-derived goal, constraints, latest prompt and plan.
- Post-tool trim that keeps error-looking lines and archives the original under `~/.reflex/archive/`.
- Providers: `none` (default), `jev` (hosted, 429 retry), `laya` (local, via `reflex serve` over a Unix socket), `llm` (Claude Haiku 4.5 baseline).
- CLI: `init [--global]`, `replay`, `stats`, `watch`, `doctor`, `clean`, `serve`.
- Benchmark routing arm: Sonnet 5 $1.75 → $0.28 with Jev routing, same outcome.
- Destructive-pattern hits judged in context by Jev at ask/auto/ultra (requested/needed proceed with a note; unrelated/forbidden prompt); model calls on reads only in ultra.
- Levels (`off | watch | nudge | ask | auto | ultra`) as presets over the config, `reflex level`; unattended levels deny risky calls instead of asking; Jev per-step model routing in the AI SDK adapter.
- Codex CLI host (`reflex-hook --codex`, `reflex init --codex|--all`), prompt-derived goals independent of host transcripts, `apply_patch` classification, install skill and agent install prompt.
- Live reference tracking; session ledger injected on `SessionStart` after compaction/resume; user-facing context gauge via `systemMessage`; `reflex report` (near misses, polling loops, dead weight); `reflex replay --import`.
- Vercel AI SDK adapter: `withReflex` tool wrapping and `reflexPrepareStep` checkpointed collapse; verb-based classification for arbitrary tool names.
- Polling-loop warning, `UserPromptSubmit` constraint restatement, repetitive small-output trim, relevance question on reads, replay collapse simulation and false-trim detection.
- Disk-backed decision cache shared across hook processes; `modelClasses` config; hook errors logged to `~/.reflex/errors.log`.
