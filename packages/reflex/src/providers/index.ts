import { noneProvider, type Provider } from '../provider.js';
import { jevProvider } from './jev.js';
import { socketProvider } from './socket.js';

export const LAYA_STATE_TOKENS = 400;

/** Resolve the configured provider name for use inside a hook process. Local models go through the socket daemon. */
export function providerFromConfig(name: string | undefined): Provider {
  switch (name) {
    case undefined:
    case 'none': return noneProvider;
    case 'jev': return jevProvider();
    case 'llm': return llmOrNone();
    case 'laya': return socketProvider({ daemonProvider: 'laya', maxStateTokens: LAYA_STATE_TOKENS });
    default: return noneProvider;
  }
}

function llmOrNone(): Provider {
  // Lazy so the hook process never pays for the SDK import unless configured.
  return {
    name: 'llm', maxStateTokens: 8000,
    async decide(state, questions, opts) { const { llmProvider } = await import('./llm.js'); return llmProvider().decide(state, questions, opts); },
  };
}

/** Provider factory for `reflex serve --provider <name>`: loads the heavy local model in-process. */
export async function daemonProvider(name: string): Promise<Provider> {
  if (name === 'laya') {
    const pkg = 'agent-reflex-laya'; // variable so bundlers and vitest do not resolve the optional package eagerly
    const mod = (await import(/* @vite-ignore */ pkg)) as { layaProvider: () => Promise<Provider> };
    return mod.layaProvider();
  }
  if (name === 'jev') return jevProvider();
  throw new Error(`unknown daemon provider: ${name}`);
}
