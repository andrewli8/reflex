#!/usr/bin/env node
import { handleHook, type HookInput } from './adapters/claude-code.js';

let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => { raw += c; });
process.stdin.on('end', async () => {
  let input: HookInput | undefined;
  try { input = JSON.parse(raw) as HookInput; } catch { process.exit(0); }
  const out = await handleHook(input!, process.argv.includes('--codex') ? 'codex' : 'claude-code');
  if (out) process.stdout.write(JSON.stringify(out));
  process.exit(0);
});
