import { describe, expect, it } from 'vitest';
import { classify } from '../src/classify.js';

const cwd = '/home/u/proj';

describe('classify', () => {
  it('maps Claude Code built-ins', () => {
    expect(classify('Read', { file_path: 'a.ts' }, cwd).class).toBe('read');
    expect(classify('Grep', { pattern: 'x' }, cwd).class).toBe('search');
    expect(classify('WebFetch', { url: 'https://x' }, cwd).class).toBe('network');
    expect(classify('Edit', { file_path: 'a.ts' }, cwd)).toMatchObject({ class: 'write', readOnly: false });
    expect(classify('Task', {}, cwd).class).toBe('exec');
  });

  it('classifies arbitrary tool names by verb', () => {
    expect(classify('read', { path: 'a' }, cwd)).toMatchObject({ class: 'read', readOnly: true });
    expect(classify('searchDocs', {}, cwd).class).toBe('read');
    expect(classify('writeFile', {}, cwd).class).toBe('write');
    expect(classify('bash', { command: 'git push --force' }, cwd)).toMatchObject({ class: 'vcs', destructivePattern: expect.any(String) });
    expect(classify('runSql', {}, cwd).class).toBe('db');
    expect(classify('frobnicate', {}, cwd)).toMatchObject({ class: 'exec', ambiguous: true });
  });
  it('classifies MCP tools by verb', () => {
    expect(classify('mcp__github__list_issues', {}, cwd).class).toBe('read');
    expect(classify('mcp__Neon__run_sql', {}, cwd).class).toBe('db');
    expect(classify('mcp__foo__do_thing', {}, cwd)).toMatchObject({ class: 'exec', ambiguous: true });
  });

  it('classifies bash by first word and takes the most mutating segment', () => {
    expect(classify('Bash', { command: 'cat x | grep y' }, cwd)).toMatchObject({ class: 'read', readOnly: true });
    expect(classify('Bash', { command: 'git status' }, cwd).class).toBe('read');
    expect(classify('Bash', { command: 'git commit -m "a && b"' }, cwd).class).toBe('vcs');
    expect(classify('Bash', { command: 'git status && rm -rf /' }, cwd)).toMatchObject({ class: 'exec', destructivePattern: expect.any(String) });
    expect(classify('Bash', { command: './unknown.sh' }, cwd)).toMatchObject({ class: 'exec', ambiguous: true });
    expect(classify('Bash', { command: 'psql -c "select 1"' }, cwd).class).toBe('db');
    expect(classify('Bash', { command: 'curl -X POST https://x' }, cwd).class).toBe('exec');
    expect(classify('Bash', { command: 'curl https://x' }, cwd).class).toBe('network');
  });

  it('flags destructive patterns', () => {
    const p = (c: string) => classify('Bash', { command: c }, cwd).destructivePattern;
    expect(p('git push --force origin main')).toBeTruthy();
    expect(p('git push -f')).toBeTruthy();
    expect(p('git push --force-with-lease')).toBeUndefined();
    expect(p('git reset --hard')).toBeTruthy();
    expect(p('git branch -D x')).toBeTruthy();
    expect(p('rm -rf /home/u/proj/build')).toBeUndefined();
    expect(p('rm -rf /Users/other/x')).toBeTruthy();
    expect(p('rm -rf .')).toBeTruthy();
    expect(p('psql -c "DELETE FROM users"')).toBeTruthy();
    expect(p('psql -c "DELETE FROM users WHERE id=1"')).toBeUndefined();
    expect(p('kubectl delete pod x')).toBeTruthy();
    expect(p('git commit --no-verify')).toBeTruthy();
    expect(p('ls')).toBeUndefined();
    expect(p("cat > /private/tmp/scratch/x.json <<'EOF'\n{}\nEOF")).toBeUndefined();
    expect(p('rm -rf /private/tmp/scratch/x')).toBeUndefined();
    expect(p('grep -n "drop function" migrations/')).toBeUndefined();
    expect(classify('Bash', { command: "cd sub && cat > out.txt <<'EOF'\nhi\nEOF" }, cwd).class).toBe('write');
  });
});
