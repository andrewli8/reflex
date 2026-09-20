---
name: reflex-install
description: Install and verify Reflex (agent-reflex) hooks for Claude Code and Codex in the current project. Use when the user asks to install Reflex, add Reflex hooks, set up agent reflexes, or run a Reflex report.
---

# Install Reflex

Reflex is a hook layer that advises the agent's own permission system: it nudges on duplicate reads, escalates destructive commands to the permission prompt, trims oversized tool output, restates task constraints each turn, and hands the model a ledger of what it already verified after compaction. It is advisory; it never replaces permissions or sandboxing.

## Steps

1. Install the CLI globally so the hook command survives upgrades:
   ```bash
   npm i -g agent-reflex
   ```
   If global install is not possible, `npx -y agent-reflex@latest init` also works; the hook will then point at an absolute path and `reflex init` must be re-run after upgrades.

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
   It prints the config mode (default `nudge`), provider (default `none`, no model needed), and hook state.

4. Show the user what Reflex would have done on their past sessions before changing any mode:
   ```bash
   reflex replay --last 20 --import
   reflex report
   ```

5. Optional decision model. Only if the user has a key:
   ```json
   // reflex.config.json in the project root
   { "mode": "nudge", "provider": "jev" }
   ```
   with `TYPESAFE_API_KEY` exported. Do not enable `enforce` until the user has reviewed a report.

## Verify

Ask the model to read the same file twice; the second read should carry a `[reflex]` note. A `git push --force` should hit the permission prompt with a Reflex reason.

## Do not

- Do not edit `reflex.config.json` to `enforce` without the user asking.
- Do not add `neverIntervene` entries to silence destructive-pattern asks; they are never silenced by design.
- Do not describe Reflex as a security boundary.
