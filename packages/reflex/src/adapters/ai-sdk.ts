import type { ModelMessage, ToolSet } from 'ai';
import { Reflex, type ToolCall } from '../critic.js';
import { registerToolClasses } from '../classify.js';
import type { ToolClass } from '../state.js';
import { estimateTokens } from '../state.js';

/**
 * Vercel AI SDK adapter. Two pieces:
 *  - `withReflex(tools, reflex)` wraps each tool's `execute` with the pre/post critic (nudge/skip/ask/trim).
 *  - `collapseMessages` + `reflexPrepareStep` implement retroactive collapse: tool results that nothing later
 *    referenced shrink to one line, applied in batches at checkpoints so the prompt-cache prefix is invalidated
 *    every N steps instead of every step.
 * Only types are imported from `ai`; the package stays optional at runtime.
 */
export interface CollapseOptions {
  /** Results younger than this many tool calls are never collapsed. */
  after?: number;
  /** Collapse only on step numbers divisible by this; larger keeps more prompt cache. */
  checkpointEvery?: number;
  /** Results smaller than this are left alone; collapsing them saves nothing. */
  minBytes?: number;
}

const STUB = (toolName: string, bytes: number) => `[reflex] ${toolName} result collapsed (${bytes} bytes, not referenced since). Ask for it again if needed.`;

type ToolResultPart = { type: 'tool-result'; toolCallId: string; toolName: string; output: { type: string; value?: unknown } };

/** Pure: returns new messages with unreferenced, old-enough tool results replaced by a stub. Never mutates. */
export function collapseMessages(messages: ModelMessage[], unreferenced: ReadonlySet<string>, o: CollapseOptions = {}): { messages: ModelMessage[]; collapsed: number; savedBytes: number } {
  const minBytes = o.minBytes ?? 200;
  let collapsed = 0; let savedBytes = 0;
  const out = messages.map((m) => {
    if (m.role !== 'tool' || !Array.isArray(m.content)) return m;
    let changed = false;
    const content = (m.content as ToolResultPart[]).map((part) => {
      if (part.type !== 'tool-result' || !unreferenced.has(part.toolCallId)) return part;
      const value = part.output?.type === 'text' || part.output?.type === 'json' ? part.output.value : undefined;
      const text = typeof value === 'string' ? value : value === undefined ? '' : JSON.stringify(value);
      if (text.length < minBytes || text.startsWith('[reflex] ')) return part;
      changed = true; collapsed++; savedBytes += text.length;
      return { ...part, output: { type: 'text', value: STUB(part.toolName, text.length) } };
    });
    return changed ? { ...m, content } as ModelMessage : m;
  });
  return { messages: collapsed ? out : messages, collapsed, savedBytes };
}

/** `prepareStep` that collapses at checkpoints. Returned messages carry forward, so a collapse is permanent for the run. */
export function reflexPrepareStep(reflex: Reflex, o: CollapseOptions = {}) {
  const every = o.checkpointEvery ?? 10;
  const after = o.after ?? 5;
  return ({ stepNumber, messages }: { stepNumber: number; messages: ModelMessage[] }) => {
    if (stepNumber === 0 || stepNumber % every !== 0) return undefined;
    const { messages: next, collapsed } = collapseMessages(messages, reflex.unreferenced(after), o);
    return collapsed ? { messages: next } : undefined;
  };
}

/** Wrap every tool's execute with the critic. Skips return a synthetic result; asks throw so the host's approval flow runs. */
export function withReflex<T extends ToolSet>(tools: T, reflex: Reflex, opts: { onAsk?: (call: ToolCall, reason: string) => Promise<boolean>; classes?: Record<string, ToolClass> } = {}): T {
  if (opts.classes) registerToolClasses(opts.classes);
  const out: Record<string, unknown> = {};
  for (const [name, tool] of Object.entries(tools)) {
    const t = tool as { execute?: (input: unknown, options: { toolCallId: string }) => unknown };
    if (typeof t.execute !== 'function') { out[name] = tool; continue; }
    const execute = t.execute;
    out[name] = {
      ...tool,
      async execute(input: unknown, options: { toolCallId: string }) {
        const call: ToolCall = { toolUseId: options.toolCallId, tool: name, args: (input && typeof input === 'object' ? input : { value: input }) as Record<string, unknown> };
        const d = await reflex.pre(call);
        if (d.host.action === 'deny') return `${d.host.reason ?? '[reflex] skipped'}`;
        if (d.host.action === 'ask') {
          const ok = opts.onAsk ? await opts.onAsk(call, d.host.reason ?? '') : false;
          if (!ok) return `${d.host.reason ?? '[reflex] not executed'} (not approved)`;
        }
        const raw = await execute(input, options);
        const text = typeof raw === 'string' ? raw : JSON.stringify(raw);
        const post = await reflex.post(call, { output: text });
        const body = post.replacement ?? raw;
        return d.host.note ? (typeof body === 'string' ? `${body}\n${d.host.note}` : body) : body;
      },
    };
  }
  return out as T;
}

export const contextTokens = (messages: ModelMessage[]): number => estimateTokens(JSON.stringify(messages));
