# agent-reflex-laya

Local, open-source decision model for [agent-reflex](https://www.npmjs.com/package/agent-reflex). Runs [Laya](https://huggingface.co/convaiinnovations/laya) (Apache 2.0, 421M parameters) on your machine through ONNX, so no tool-call state leaves your computer.

```bash
npm i -g agent-reflex agent-reflex-laya
```

In `reflex.config.json` (or `~/.reflex/config.json`):

```json
{ "level": "ask", "provider": "laya" }
```

The first hook call downloads the weights (1.7 GB) and starts a small daemon (`reflex serve --provider laya`, Unix socket under `~/.reflex`, exits after 30 idle minutes). Until it is ready, calls fall through as limited. Needs Node 22 or newer and about 2 GB of RAM.

Measured limits: Laya sees a 512-token state and on our probes only the redundancy question separated cleanly. Scope and destructive judgments stay deterministic on this provider. See the main README for numbers and the Jev comparison.

MIT
