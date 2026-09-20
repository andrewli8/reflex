/**
 * Mechanical usefulness label for replayed tool calls (plan §11). Crude and biased equally across arms:
 *  - read-only call: useful if its result is not a duplicate of an earlier result AND a later assistant
 *    text or tool input uses an identifier that first appeared in this result;
 *  - repeated test/build command: useful if its output differs from the previous run of the same command;
 *  - mutating calls are not labelled (SKIP never applies to them).
 */
const IDENT = /[A-Za-z_][A-Za-z0-9_./-]{3,}/g;
const MAX_NOVEL = 5000;

/** Identifier-like tokens: must contain something beyond lowercase letters, which filters ordinary prose. */
export function identifiers(text: string): Set<string> {
  const out = new Set<string>();
  for (const m of text.matchAll(IDENT)) {
    const t = m[0];
    if (/[A-Z0-9_./-]/.test(t)) out.add(t);
    // `req.query.next_url` and `src/auth.ts` are also referenced by their parts.
    if (/[./]/.test(t)) for (const part of [...t.split('/'), ...t.split('.')]) if (part !== t && part.length >= 4 && /[A-Z0-9_./-]/.test(part)) out.add(part);
  }
  return out;
}

interface Pending { id: string; novel: Set<string>; kept?: Set<string> }

export class UsefulnessTracker {
  private readonly seen = new Set<string>();
  private readonly resultHashes = new Set<string>();
  private readonly lastOutputByCommand = new Map<string, string>();
  private pending: Pending[] = [];
  readonly useful = new Set<string>();
  readonly labelled = new Set<string>();
  /** Step index at which a result was first referenced. */
  readonly usedAt = new Map<string, number>();
  /** Results whose first later reference used an identifier that only existed in the trimmed-away part. */
  readonly lostReference = new Set<string>();
  step = 0;

  /** Context the agent already had: prompts, assistant text, tool inputs. Consumes pending novel tokens. */
  context(text: string): void {
    const ids = identifiers(text);
    for (const p of this.pending) for (const t of ids) if (p.novel.has(t)) { this.useful.add(p.id); this.usedAt.set(p.id, this.step); if (p.kept && !p.kept.has(t)) this.lostReference.add(p.id); break; }
    this.pending = this.pending.filter((p) => !this.useful.has(p.id));
    for (const t of ids) this.seen.add(t);
  }

  /** A read-only call's result. */
  readResult(id: string, output: string, hash: string, kept?: string): void {
    this.labelled.add(id);
    if (this.resultHashes.has(hash)) { this.seenAll(output); return; }
    this.resultHashes.add(hash);
    const novel = new Set<string>();
    for (const t of identifiers(output)) { if (!this.seen.has(t) && novel.size < MAX_NOVEL) novel.add(t); this.seen.add(t); }
    if (novel.size) this.pending = [...this.pending, { id, novel, ...(kept !== undefined ? { kept: identifiers(kept) } : {}) }];
  }

  /** A test/build style command: useful when its output changed since the last run of the same command. */
  commandResult(id: string, command: string, output: string): void {
    this.labelled.add(id);
    const prev = this.lastOutputByCommand.get(command);
    if (prev !== undefined && prev !== output) { this.useful.add(id); this.usedAt.set(id, this.step); }
    this.lastOutputByCommand.set(command, output);
    this.seenAll(output);
  }

  private seenAll(text: string): void { for (const t of identifiers(text)) this.seen.add(t); }
}
