# Prompt: install Reflex in this project

Paste this into Claude Code, Codex, or any coding agent with shell access.

---

Install Reflex (npm package `agent-reflex`) in this project and verify it works. Reflex is an advisory hook layer for coding agents: it nudges on duplicate reads, sends destructive commands (force push, hard reset, DELETE without WHERE, rm -rf outside the project) to the permission prompt, trims oversized tool output while keeping error lines, restates my task constraints every turn, and after compaction hands you a ledger of what was already read, edited and verified. It does not replace permissions or sandboxing.

Do the following, in order, and report each result:

1. `npm i -g agent-reflex`. If that fails for permission reasons, use `npx -y agent-reflex@latest` in place of `reflex` below and tell me the hook will need re-running after upgrades.
2. From the project root run `reflex init --all` so hooks are installed for both Claude Code (`.claude/settings.json`) and Codex (`.codex/hooks.json`). Show me the diff of any settings file you changed. Do not remove existing hooks.
3. Run `reflex doctor` and paste the output. If Codex is in use, remind me to open `codex` interactively once in this project and approve the Reflex hook prompt, because Codex skips untrusted repo hooks in `codex exec`.
4. Run `reflex replay --last 20 --import` and then `reflex report`, and summarise in three lines what Reflex would have caught or trimmed in my past sessions, including any near misses.
5. Verify live: read the same file twice with the Read tool and confirm the second read carried a `[reflex]` note.
6. Leave the mode at `nudge` and the provider at `none`. Do not enable `enforce` or a decision model unless I ask.

If any step fails, show the exact error and stop rather than working around it.
