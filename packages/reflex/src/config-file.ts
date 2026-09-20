import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { applyLevel, defaultConfig, LEVELS, type Level, type ReflexConfig } from './config.js';
import { reflexHome } from './session.js';

const MODES = new Set(['shadow', 'nudge', 'enforce']);

function pick(raw: unknown): Partial<ReflexConfig> {
  if (!raw || typeof raw !== 'object') return {};
  const r = raw as Record<string, unknown>;
  const out: Partial<ReflexConfig> = {};
  if (typeof r['level'] === 'string' && (LEVELS as string[]).includes(r['level'])) out.level = r['level'] as Level;
  else if (r['level'] === 'nudge') { out.level = 'ask'; out.mode = 'nudge'; out.provider = 'none'; } // retired level, kept readable
  if (typeof r['mode'] === 'string' && MODES.has(r['mode'])) out.mode = r['mode'] as ReflexConfig['mode'];
  if (typeof r['askBecomesDeny'] === 'boolean') out.askBecomesDeny = r['askBecomesDeny'];
  if (typeof r['judgePatterns'] === 'boolean') out.judgePatterns = r['judgePatterns'];
  if (typeof r['modelOnReads'] === 'boolean') out.modelOnReads = r['modelOnReads'];
  if (r['routing'] && typeof r['routing'] === 'object') out.routing = { ...defaultConfig.routing, ...(r['routing'] as object) };
  if (r['collapse'] && typeof r['collapse'] === 'object') out.collapse = { ...defaultConfig.collapse, ...(r['collapse'] as object) };
  if (Array.isArray(r['neverIntervene'])) out.neverIntervene = r['neverIntervene'].filter((x): x is string => typeof x === 'string');
  if (typeof r['maxInterventionsPer5Steps'] === 'number') out.maxInterventionsPer5Steps = r['maxInterventionsPer5Steps'];
  if (typeof r['askOnModelRisk'] === 'boolean') out.askOnModelRisk = r['askOnModelRisk'];
  if (typeof r['providerTimeoutMs'] === 'number') out.providerTimeoutMs = r['providerTimeoutMs'];
  if (r['gauge'] && typeof r['gauge'] === 'object') out.gauge = { ...defaultConfig.gauge, ...(r['gauge'] as object) };
  if (r['ledger'] && typeof r['ledger'] === 'object') out.ledger = { ...defaultConfig.ledger, ...(r['ledger'] as object) };
  if (Array.isArray(r['modelClasses'])) out.modelClasses = r['modelClasses'].filter((x): x is string => typeof x === 'string');
  if (r['thresholds'] && typeof r['thresholds'] === 'object') {
    const t = Object.fromEntries(Object.entries(r['thresholds'] as Record<string, unknown>).filter(([k, v]) => k in defaultConfig.thresholds && typeof v === 'number'));
    out.thresholds = { ...defaultConfig.thresholds, ...t };
  }
  if (r['trim'] && typeof r['trim'] === 'object') out.trim = { ...defaultConfig.trim, ...(r['trim'] as object) };
  if (r['drop'] && typeof r['drop'] === 'object') out.drop = { ...defaultConfig.drop, ...(r['drop'] as object) };
  if (typeof r['provider'] === 'string') (out as Record<string, unknown>)['provider'] = r['provider'];
  return out;
}

function readJson(path: string): unknown {
  if (!existsSync(path)) return undefined;
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return undefined; }
}

/** Project `reflex.config.json` overrides `~/.reflex/config.json` overrides defaults. Unknown keys are ignored, bad values dropped. */
/** Preset from `level` first (project wins), then explicit keys from user then project files. */
export function loadConfig(cwd: string): ReflexConfig {
  const user = pick(readJson(join(reflexHome(), 'config.json')));
  const project = pick(readJson(join(cwd, 'reflex.config.json')));
  const level = project.level ?? user.level ?? defaultConfig.level;
  const base = applyLevel(level);
  const { level: _u, ...userRest } = user; const { level: _p, ...projectRest } = project;
  return { ...base, ...userRest, ...projectRest, thresholds: { ...base.thresholds, ...user.thresholds, ...project.thresholds }, trim: { ...base.trim, ...user.trim, ...project.trim } };
}
