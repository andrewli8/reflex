import { isAbsolute, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import type { ToolClass } from './state.js';

export interface Classification {
  class: ToolClass;
  readOnly: boolean;
  ambiguous: boolean;
  /** Set when a known destructive pattern matched. Always ASK, never a security boundary. */
  destructivePattern?: string;
}

const RANK: Record<ToolClass, number> = { read: 0, search: 1, network: 2, write: 3, exec: 4, vcs: 5, db: 6 };
const READ_ONLY = new Set<ToolClass>(['read', 'search', 'network']);

const BUILTIN: Record<string, ToolClass> = {
  Read: 'read', Glob: 'read', LS: 'read', NotebookRead: 'read', TodoRead: 'read',
  Grep: 'search', WebSearch: 'search', WebFetch: 'network',
  Edit: 'write', Write: 'write', MultiEdit: 'write', NotebookEdit: 'write',
  Bash: 'exec', Task: 'exec', Agent: 'exec',
  // Codex CLI
  apply_patch: 'write', exec_command: 'exec', update_plan: 'read', spawn_agent: 'exec', view_image: 'read',
};

const BASH_READ = new Set(['cd', 'export', 'source', 'set', 'unset', 'command', 'builtin', 'time', 'cat', 'ls', 'head', 'tail', 'wc', 'stat', 'find', 'echo', 'pwd', 'which', 'type', 'env', 'printenv', 'true', 'tree', 'du', 'df', 'file', 'grep', 'rg', 'ag', 'awk', 'sort', 'uniq', 'cut', 'tr', 'diff', 'jq', 'yq', 'less', 'more', 'test', 'date', 'whoami', 'uname', 'basename', 'dirname', 'realpath', 'xargs']);
const BASH_WRITE = new Set(['tee', 'cp', 'mv', 'mkdir', 'touch', 'chmod', 'chown', 'ln', 'rmdir', 'install']);
const BASH_DB = new Set(['psql', 'mysql', 'sqlite3', 'mongosh', 'mongo', 'redis-cli', 'clickhouse-client']);
const BASH_NET = new Set(['curl', 'wget', 'http', 'https', 'xh']);
const BASH_EXEC = new Set(['npm', 'pnpm', 'yarn', 'bun', 'npx', 'node', 'make', 'cargo', 'go', 'python', 'python3', 'pytest', 'jest', 'vitest', 'tsc', 'docker', 'kubectl', 'gh', 'rm', 'sed', 'pip', 'uv', 'ruby', 'java', 'mvn', 'gradle', 'terraform', 'vercel', 'aws', 'gcloud', 'az']);
const GIT_READ = new Set(['status', 'log', 'diff', 'show', 'rev-parse', 'describe', 'blame', 'ls-files', 'remote', 'fetch', 'config', 'tag', 'shortlog', 'reflog', 'cat-file', 'grep']);
const NET_MUTATING = /^(-X|--request)$|^-d$|^--data|^-T$|^--upload-file$|^-F$|^--form$/;

/** Remove heredoc bodies (`<<EOF` … `EOF`): they are data, not commands. The marker line stays. */
function stripHeredocs(cmd: string): string {
  const lines = cmd.split('\n');
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    out.push(line);
    const m = /<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1/.exec(line);
    if (!m) continue;
    const term = m[2]!;
    for (i++; i < lines.length && lines[i]!.trim() !== term; i++) { /* skip body */ }
  }
  return out.join('\n');
}

/** Split a shell command on && || ; | and newlines, respecting quotes and skipping heredoc bodies. */
export function splitCommand(cmd: string): { raw: string; tokens: string[] }[] {
  cmd = stripHeredocs(cmd);
  const out: { raw: string; tokens: string[] }[] = [];
  let seg = '';
  let quote: string | null = null;
  const push = () => { const raw = seg.trim(); if (raw) out.push({ raw, tokens: tokenize(raw) }); seg = ''; };
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i]!;
    if (quote) { seg += c; if (c === quote && cmd[i - 1] !== '\\') quote = null; continue; }
    if (c === '"' || c === "'") { quote = c; seg += c; continue; }
    if (c === '\n' || c === ';' || c === '|' || c === '&') {
      if ((c === '|' || c === '&') && cmd[i + 1] === c) i++;
      else if (c === '&') { seg += c; continue; }
      push(); continue;
    }
    seg += c;
  }
  push();
  return out;
}

function tokenize(raw: string): string[] {
  const tokens: string[] = [];
  const re = /"((?:[^"\\]|\\.)*)"|'([^']*)'|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw))) tokens.push(m[1] ?? m[2] ?? m[3] ?? '');
  return tokens;
}

const TMP_ROOTS = ['/tmp/', '/private/tmp/', '/var/folders/', '/private/var/folders/', resolve(tmpdir()) + '/'];

/** True for paths whose deletion is likely unintended: cwd itself, its parents, home, root, or anywhere outside cwd except scratch dirs. */
function outsideCwd(p: string, cwd: string): boolean {
  if (p === '~' || p.startsWith('~/') || p === '/' || p === '*' || p === '.' || p === './' || p === '..') return true;
  const abs = isAbsolute(p) ? resolve(p) : resolve(cwd, p);
  if (TMP_ROOTS.some((r) => abs.startsWith(r))) return false;
  return abs === resolve(cwd) || !abs.startsWith(resolve(cwd) + '/');
}

function destructive(raw: string, t: string[], cwd: string): string | undefined {
  const [cmd, sub] = [t[0] ?? '', t[1] ?? ''];
  const has = (f: string) => t.includes(f);
  if (cmd === 'git') {
    if (sub === 'push' && (has('--force') || has('-f')) && !has('--force-with-lease')) return 'git push --force';
    if (sub === 'reset' && has('--hard')) return 'git reset --hard';
    if (sub === 'clean' && t.some((x) => /^-[a-zA-Z]*f/.test(x))) return 'git clean -f';
    if (sub === 'branch' && has('-D')) return 'git branch -D';
    if ((sub === 'checkout' || sub === 'restore') && (has('.') || t.at(-1) === '.')) return `git ${sub} .`;
    if (has('--no-verify')) return '--no-verify';
  }
  if (cmd === 'rm' && t.some((x) => /^-[a-zA-Z]*[rf]/.test(x))) {
    const targets = t.slice(1).filter((x) => !x.startsWith('-'));
    if (targets.some((p) => outsideCwd(p, cwd))) return 'rm -rf outside cwd';
  }
  if (cmd === 'kubectl' && sub === 'delete') return 'kubectl delete';
  if (cmd === 'docker' && sub === 'system' && t[2] === 'prune') return 'docker system prune';
  // SQL patterns only when a database client is actually being invoked; a grep for "drop policy" is not a drop.
  const dbClient = BASH_DB.has(cmd) || t.some((x) => BASH_DB.has(x));
  if (dbClient && /\b(drop|truncate)\s+(table|database|schema|index)\b/i.test(raw)) return 'DROP/TRUNCATE';
  if (dbClient && /\bdelete\s+from\b/i.test(raw) && !/\bwhere\b/i.test(raw)) return 'DELETE without WHERE';
  // ponytail: no redirect pattern. Heredocs and `> file` are how agents write files; a redirect onto an important path is an ASK for the model, not a regex.
  return undefined;
}

function classifySegment(t: string[]): { class: ToolClass; ambiguous: boolean } {
  const cmd = t[0] ?? '';
  const sub = t[1] ?? '';
  const known = (c: ToolClass) => ({ class: c, ambiguous: false });
  if (t.some((x) => x === '>' || x === '>>' || /^>>?[^&]/.test(x))) return known('write');
  if (cmd === 'git') {
    if (sub === 'branch') return known(t.some((x) => /^-[dDm]$/.test(x)) ? 'vcs' : 'read');
    if (sub === 'stash') return known(t[2] === 'list' || t[2] === 'show' ? 'read' : 'vcs');
    return known(GIT_READ.has(sub) ? 'read' : 'vcs');
  }
  if (cmd === 'gh') {
    if (['view', 'list', 'status', 'diff', 'checks'].includes(t[2] ?? '')) return known('read');
    if (sub === 'pr' && t[2] === 'merge') return known('vcs');
    if (sub === 'release' || (sub === 'repo' && t[2] === 'delete')) return known('vcs');
    return known('exec');
  }
  if (cmd === 'docker') return known(['ps', 'images', 'logs', 'inspect', 'version', 'info'].includes(sub) ? 'read' : 'exec');
  if (cmd === 'kubectl') return known(['get', 'describe', 'logs', 'version', 'explain'].includes(sub) ? 'read' : 'exec');
  if (cmd === 'sed') return known(t.some((x) => /^-[a-zA-Z]*i/.test(x)) ? 'write' : 'read');
  if (cmd === 'prisma') return known(['migrate', 'db'].includes(sub) ? 'db' : 'exec');
  if (BASH_NET.has(cmd)) return known(t.some((x) => NET_MUTATING.test(x)) ? 'exec' : 'network');
  if (BASH_READ.has(cmd)) return known('read');
  if (BASH_WRITE.has(cmd)) return known('write');
  if (BASH_DB.has(cmd)) return known('db');
  if (BASH_EXEC.has(cmd)) return known('exec');
  return { class: 'exec', ambiguous: true };
}

function classifyBash(command: string, cwd: string): Classification {
  let best: { class: ToolClass; ambiguous: boolean } = { class: 'read', ambiguous: false };
  let pattern: string | undefined;
  for (const seg of splitCommand(command)) {
    const c = classifySegment(seg.tokens);
    if (RANK[c.class] > RANK[best.class] || (RANK[c.class] === RANK[best.class] && c.ambiguous)) best = c;
    pattern ??= destructive(seg.raw, seg.tokens, cwd);
  }
  if (splitCommand(command).length === 0) best = { class: 'exec', ambiguous: true };
  return { class: best.class, readOnly: READ_ONLY.has(best.class), ambiguous: best.ambiguous, ...(pattern ? { destructivePattern: pattern } : {}) };
}

function classifyMcp(name: string): Classification {
  const parts = name.split('__');
  const server = (parts[1] ?? '').toLowerCase();
  const tool = (parts.at(-1) ?? '').toLowerCase();
  const known = (c: ToolClass): Classification => ({ class: c, readOnly: READ_ONLY.has(c), ambiguous: false });
  if (/^(query|execute|run_sql|delete|drop|truncate|insert|update)/.test(tool) || /neon|postgres|mysql|supabase|sql/.test(server)) return known('db');
  if (/^(get|read|list|fetch|search|find|describe|resolve|query_docs|query-docs)/.test(tool)) return known('read');
  return { class: 'exec', readOnly: false, ambiguous: true };
}

/** Explicit class hints for hosts with arbitrary tool names (AI SDK, Codex). Set once via `registerToolClasses`. */
const HINTS = new Map<string, ToolClass>();
export function registerToolClasses(classes: Record<string, ToolClass>): void { for (const [k, v] of Object.entries(classes)) HINTS.set(k, v); }

const VERB_READ = /^(read|get|list|fetch|search|find|grep|glob|ls|cat|view|show|describe|query_docs|lookup|browse|scan|inspect|stat|head|tail)(_|[A-Z]|$)/i;
const VERB_WRITE = /^(write|edit|create|update|patch|append|replace|save|move|rename|mkdir|touch|copy)(_|[A-Z]|$)/i;
const VERB_DB = /sql|database|migrat|^db_|^query(_|[A-Z]|$)/i;
const VERB_EXEC = /^(bash|shell|run|exec|execute|command|terminal|python|node|spawn)(_|[A-Z]|$)/i;

function classifyGeneric(tool: string, args: Record<string, unknown>, cwd: string): Classification {
  const hinted = HINTS.get(tool);
  const known = (c: ToolClass, ambiguous = false): Classification => ({ class: c, readOnly: READ_ONLY.has(c), ambiguous });
  if (hinted) return known(hinted);
  if (VERB_EXEC.test(tool) && typeof args['command'] === 'string') return classifyBash(args['command'], cwd);
  if (VERB_DB.test(tool)) return known('db');
  if (VERB_WRITE.test(tool)) return known('write');
  if (VERB_READ.test(tool)) return known('read');
  if (VERB_EXEC.test(tool)) return known('exec');
  return known('exec', true);
}

export function classify(tool: string, args: Record<string, unknown>, cwd: string): Classification {
  if (tool === 'Bash') return classifyBash(String(args['command'] ?? ''), cwd);
  if (tool.startsWith('mcp__')) return classifyMcp(tool);
  const c = BUILTIN[tool];
  if (c) return { class: c, readOnly: READ_ONLY.has(c), ambiguous: false };
  return classifyGeneric(tool, args, cwd);
}
