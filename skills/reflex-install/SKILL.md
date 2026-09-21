---
name: reflex-install
description: Install and verify Reflex (reflex-hooks) hooks for Claude Code and Codex in the current project. Use when the user asks to install Reflex, add Reflex hooks, set up agent reflexes, or run a Reflex report.
---

# Install Reflex

Reflex is a hook layer that advises the agent's own permission system: it nudges on duplicate reads, escalates destructive commands to the permission prompt, trims oversized tool output, restates task constraints each turn, and hands the model a ledger of what it already verified after compaction. It is advisory; it never replaces permissions or sandboxing.

## Steps

1. Install the CLI globally so the hook command survives upgrades:
   ```bash
   npm i -g reflex-hooks
   ```
   If global install is not possible, `npx -y -p reflex-hooks@latest reflex init` also works; the hook will then point at an absolute path and `reflex init` must be re-run after upgrades.

2. From the project root, install hooks for the hosts in use:
   ```bash
   reflex init          # Claude Code: .claude/settings.json
   reflex init --codex  # Codex CLI: .codex/hooks.json
   reflex init --all    # both
   ```
   Add `--global` to install into `~/.claude/settings.json` or `~/.codex/hooks.json` instead of the project.
   For Codex, tell the user to open `codex` interactively once in the project and approve the Reflex hook when prompted; Codex trusts repo hooks per hook and skips untrusted ones in `codex exec`.

3. Confirm the install:
   ```bash
   reflex doctor
   ```
   It prints the level (default `ask`), provider (default `jev`), whether a Jev key is present, and hook state. Without a key it says LIMITED: candidates are found but not judged.

4. Show the user what Reflex would have done on their past sessions before changing any mode:
   ```bash
   reflex replay --last 20 --import
   reflex report
   ```

5. Jev key. `init` asks for it; if skipped, store it later with `reflex key jev <key>`. The key comes from TypeSafe (typesafe.ai). Do not switch the level to `auto` or `ultra` unless the user asks.

## Verify

Ask the model to read the same file twice; the second read should carry a `[reflex]` note. A `git push --force` should hit the permission prompt with a Reflex reason.

## Do not

- Do not change the level to `auto` or `ultra` without the user asking.
- Do not add `neverIntervene` entries to silence destructive-pattern asks; they are never silenced by design.
- Do not describe Reflex as a security boundary.
