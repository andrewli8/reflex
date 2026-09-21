# Prompt: install Reflex in this project

Paste this into Claude Code, Codex, or any coding agent with shell access.

---

Install Reflex (npm package `reflex-hooks`) in this project and verify it works. Reflex is an advisory hook layer for coding agents: it asks Jev, a small decision model, whether a destructive command belongs to my task and whether an edit breaks a constraint I stated, and sends the call to the permission prompt only when it does not. It also restates my constraints every turn, hands you a ledger after compaction, and trims oversized output. It does not replace permissions or sandboxing.

Do the following, in order, and report each result:

1. `npm i -g reflex-hooks`. If that fails for permission reasons, use `npx -y reflex-hooks@latest` in place of `reflex` below and tell me the hook will need re-running after upgrades.
2. From the project root run `reflex init --all` so hooks are installed for both Claude Code (`.claude/settings.json`) and Codex (`.codex/hooks.json`). Show me the diff of any settings file you changed. Do not remove existing hooks.
3. Run `reflex doctor` and paste the output. If Codex is in use, remind me to open `codex` interactively once in this project and approve the Reflex hook prompt, because Codex skips untrusted repo hooks in `codex exec`.
4. Run `reflex replay --last 20 --import` and then `reflex report`, and summarise in three lines what Reflex would have caught or trimmed in my past sessions, including any near misses.
5. Verify live: read the same file twice with the Read tool and confirm the second read carried a `[reflex]` note.
6. Leave the level at `ask`. If `reflex doctor` says LIMITED, ask me for my Jev key and store it with `reflex key jev <key>`; do not move to `auto` or `ultra` unless I ask.

If any step fails, show the exact error and stop rather than working around it.
