import { Reflex, type ReflexEvent, type ToolCall } from '../critic.js';
import { loadConfig } from '../config-file.js';
import { appendEvent, readTail, sessionPath } from '../session.js';
import { readGoal, readTailState } from '../transcript.js';
import { join } from 'node:path';
import { appendFileSync, mkdirSync } from 'node:fs';
import { reflexHome } from '../session.js';
import { providerFromConfig } from '../providers/index.js';

/** Subset of the Claude Code hook stdin payload that Reflex reads. Everything else is ignored. */
export interface HookInput {
  hook_event_name: 'PreToolUse' | 'PostToolUse' | 'PostToolUseFailure' | 'PermissionRequest' | 'UserPromptSubmit' | 'SessionStart' | string;
  prompt?: string;
  source?: string;
  session_id: string;
  agent_id?: string;
  tool_use_id?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  tool_response?: unknown;
  cwd?: string;
  transcript_path?: string;
}

export type HookOutput = { hookSpecificOutput?: Record<string, unknown>; systemMessage?: string } | undefined;

export type Host = 'claude-code' | 'codex';

/**
 * Pure entry: input JSON in, output JSON (or nothing) out. Never throws; any failure means "no opinion".
 * Codex uses the same events and payload shape but has no `ask` decision and cannot rewrite tool results.
 */
export async function handleHook(input: HookInput, host: Host = 'claude-code'): Promise<HookOutput> {
  try { return await handle(input, host); } catch (e) { logError(input, e); return undefined; }
}

/** Failures never block the host, but they must be visible somewhere: one line per failure in ~/.reflex/errors.log. */
function logError(input: HookInput, e: unknown): void {
  try {
    mkdirSync(reflexHome(), { recursive: true });
    appendFileSync(join(reflexHome(), 'errors.log'), `${new Date().toISOString()} ${input.hook_event_name} ${input.tool_name ?? ''} ${(e as Error)?.stack ?? String(e)}\n`);
  } catch { /* nowhere left to report */ }
}

async function handle(input: HookInput, host: Host): Promise<HookOutput> {
  const cwd = input.cwd ?? process.cwd();
  const config = loadConfig(cwd);
  const path = sessionPath(input.session_id, input.agent_id);
  const history = readTail(path);
  if (input.hook_event_name === 'UserPromptSubmit') return promptSubmitted(input, history, path);
  if (input.hook_event_name === 'SessionStart') return sessionStart(input, history, config.ledger.enabled);
  if (input.hook_event_name === 'PreCompact') { new Reflex({ cwd, history, log: (e) => appendEvent(path, e) }).compacted(); return undefined; }
  const call = toCall(input);
  if (!call) return undefined;

  const hasGoal = history.some((e) => e.phase === 'meta' && e.goal);
  const goal = !hasGoal && host === 'claude-code' && input.transcript_path ? readGoal(input.transcript_path) : undefined;
  if (goal) appendEvent(path, { ts: Date.now(), step: 0, toolUseId: '', tool: '', class: '', summary: '', phase: 'meta', policy: 'keep', applied: 'keep', source: 'deterministic', goal: goal.goal });

  const tail = host === 'claude-code' && input.transcript_path ? readTailState(input.transcript_path) : { plan: '', latestPrompt: latestPromptFrom(history) };
  const reflex = new Reflex({
    cwd, config, history, provider: providerFromConfig(config.provider),
    ...(goal ? { goal: goal.goal, constraints: goal.constraints } : {}),
    plan: tail.plan, latestPrompt: tail.latestPrompt,
    archiveDir: join(reflexHome(), 'archive'),
    cacheDir: join(reflexHome(), 'cache'),
    log: (e: ReflexEvent) => appendEvent(path, e),
  });

  switch (input.hook_event_name) {
    case 'PreToolUse': {
      const d = await reflex.pre(call);
      const out: Record<string, unknown> = { hookEventName: 'PreToolUse' };
      let action = d.host.action;
      if (host === 'codex' && action === 'ask') {
        // Codex hooks cannot prompt the user. Enforce: deny with the reason. Nudge: tell the model to confirm with the user first.
        if (config.mode === 'enforce') action = 'deny';
        else { out['additionalContext'] = `${d.host.reason ?? '[reflex] risky call'}. Confirm with the user before running this.`; return { hookSpecificOutput: out }; }
      }
      if (action === 'deny' || action === 'ask') { out['permissionDecision'] = action; out['permissionDecisionReason'] = d.host.reason; }
      else if (d.host.note) out['additionalContext'] = d.host.note; // no permissionDecision: the host's own permission flow still runs
      else return undefined;
      return { hookSpecificOutput: out };
    }
    case 'PostToolUse': {
      const text = responseText(input.tool_response);
      const d = await reflex.post(call, { output: text ?? '' });
      const out: NonNullable<HookOutput> = {};
      if (d.userMessage) out.systemMessage = d.userMessage;
      if (d.replacement && text !== undefined && host === 'claude-code') { // Codex cannot rewrite results; the trim is logged only
        const key = call.tool.startsWith('mcp__') ? 'updatedMCPToolOutput' : 'updatedResponse';
        out.hookSpecificOutput = { hookEventName: 'PostToolUse', [key]: rewrap(input.tool_response, d.replacement) };
      }
      return out.systemMessage || out.hookSpecificOutput ? out : undefined;
    }
    case 'PostToolUseFailure': reflex.note(call, 'post', 'error'); return undefined;
    case 'PermissionRequest': reflex.note(call, 'permission'); return undefined;
    default: return undefined;
  }
}

const latestPromptFrom = (history: ReflexEvent[]): string => [...history].reverse().find((e) => e.phase === 'meta' && e.summary === 'prompt')?.goal ?? '';

/**
 * Every prompt is recorded in the session log (first one becomes the goal), so no host transcript is needed.
 * Drift starts when constraints scroll out of attention: restate them on every prompt as context the model reads.
 */
function promptSubmitted(input: HookInput, history: ReflexEvent[], path: string): HookOutput {
  const prompt = (input.prompt ?? '').trim();
  const existing = history.find((e) => e.phase === 'meta' && e.goal && e.summary !== 'prompt')?.goal;
  const goal = existing ?? (input.transcript_path ? readGoal(input.transcript_path)?.goal : undefined) ?? prompt;
  const meta = (summary: string, g: string): ReflexEvent => ({ ts: Date.now(), step: 0, toolUseId: '', tool: '', class: '', summary, phase: 'meta', policy: 'keep', applied: 'keep', source: 'deterministic', goal: g });
  if (!existing && goal) appendEvent(path, meta('', goal));
  if (prompt && prompt !== goal) appendEvent(path, meta('prompt', prompt.slice(0, 600)));
  const r = new Reflex({ cwd: input.cwd ?? process.cwd(), goal, latestPrompt: prompt });
  const cs = r.activeConstraints;
  if (!cs.length) return undefined;
  return { hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: `[reflex] Constraints still in effect from this session: ${cs.join(' | ')}` } };
}

/** After compaction or on resume, hand the model the ledger of what the session already established. */
function sessionStart(input: HookInput, history: ReflexEvent[], enabled: boolean): HookOutput {
  if (!enabled || !(input.source === 'compact' || input.source === 'resume')) return undefined;
  if (!history.some((e) => e.phase === 'post')) return undefined;
  const r = new Reflex({ cwd: input.cwd ?? process.cwd(), history });
  const ledger = r.ledger();
  if (!ledger) return undefined;
  return { hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: `[reflex] Session ledger (what was already read, edited, run and verified before ${input.source}):\n${ledger}` } };
}

function toCall(i: HookInput): ToolCall | undefined {
  if (!i.tool_name) return undefined;
  const args = i.tool_input && typeof i.tool_input === 'object' ? i.tool_input : {};
  const description = typeof args['description'] === 'string' ? args['description'] : undefined;
  return { toolUseId: i.tool_use_id ?? '', tool: i.tool_name, args, ...(description ? { description } : {}) };
}

/** Text of a tool response in the shapes Claude Code uses: string, {text}, [{type:'text',text}], or JSON-able object. */
export function responseText(r: unknown): string | undefined {
  if (typeof r === 'string') return r;
  if (Array.isArray(r)) { const t = r.filter((b) => b && typeof b === 'object' && typeof (b as { text?: unknown }).text === 'string').map((b) => (b as { text: string }).text).join('\n'); return t || undefined; }
  if (r && typeof r === 'object') {
    const o = r as Record<string, unknown>;
    for (const k of ['text', 'output', 'stdout', 'content']) if (typeof o[k] === 'string') return o[k] as string;
    return JSON.stringify(r);
  }
  return undefined;
}

/** Put replacement text back in the original shape. Unknown shapes are returned as a plain string. */
export function rewrap(original: unknown, text: string): unknown {
  if (typeof original === 'string') return text;
  if (Array.isArray(original)) return [{ type: 'text', text }];
  if (original && typeof original === 'object') {
    const o = original as Record<string, unknown>;
    for (const k of ['text', 'output', 'stdout', 'content']) if (typeof o[k] === 'string') return { ...o, [k]: text };
  }
  return text;
}
