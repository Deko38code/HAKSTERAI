# GPU lane — free external GPU for heavy work

The Dell has **no discrete GPU**. `lspci` reports one device:

```
00:02.0 VGA compatible controller: Intel Corporation HD Graphics 5500 (rev 09)
```

The HD 5500 is integrated — it has no VRAM of its own, it borrows from the same
7 GB of system RAM the box is already swapping. `/usr/local/lib/ollama` holds
only licence files (no `libggml-cuda.so`, no Vulkan backend), so the local Ollama
0.40.4 on `127.0.0.1:11434` runs **CPU-only**. There is no setting that adds GPU
RAM to this machine; the only way to get VRAM is to borrow it from a free
provider over the network.

## What actually costs GPU here (measured 2026-11-26)

| Path | GPU cost |
|---|---|
| `/api/agent/run` → `claude -p` → relay `127.0.0.1:11434` → Ollama **cloud** | **zero** — inference runs on ollama.com |
| `deepseek-v4.1-flash:cloud` (`remote_model` `deepseek-v4.1-flash:1017`) | zero — cloud, billed by request quota |
| `qwen2.5-coder:3b` (1.9 GB, local, Q4_K_M) | CPU, and `/api/ps` was **empty** — nothing loaded |
| The multi-user lag seen that day | **not GPU** — 635–730 MB of RAM per `claude -p` + its MCP servers, on a box with 1.7 GB swapped |

So a GPU lane does **not** make the agent faster. It buys capacity for work the
CPU box cannot do at all: embeddings, transcription, image/vision batch jobs,
bulk classification, local model experiments.

## The free options, verified November 2026

### Real serverless GPU (can be called over HTTP, no session cap)

| Provider | Free allowance | GPU | Hours/month at that price | Card |
|---|---|---|---|---|
| **Modal Starter** | **$30 / month credit** | T4 $0.59/hr | **~50 h** | yes, on file |
| | | L4 $0.80/hr | ~37 h | |
| | | A100 40 GB $2.10/hr | ~14 h | |
| | | H100 $3.95/hr | ~7.5 h | |

100 containers / 10 GPU concurrency, per-second billing, no per-session cap,
scales to zero. **The only free tier built like a server.**

### Free GPU, notebooks only (cannot serve a stable endpoint)

| Provider | VRAM | Free allowance | Session cap |
|---|---|---|---|
| **Kaggle** | T4 **16 GB**, up to 2× (P100 retiring) | **~30 GPU-hr/week** (~129 h/mo) | 12 h |
| Google Colab free | T4 ~16 GB typical | unpublished, GPU "heavily restricted" | 12 h |
| Lightning AI | T4 → H200, none on H100/H200 | ~30 credits ≈ **75 T4-hrs** | Studio restarts every 4 h |
| Paperspace Free | Quadro **M4000 8 GB** | 5 GB storage | 6 h auto-shutdown |
| HF ZeroGPU | RTX Pro 6000 **48 GB** / 96 GB | **5 min/day** (40 min/day PRO $9) | 60 s per call |

Kaggle gives the most raw free VRAM-hours by far (~129 h/mo vs Modal's ~50 h),
but it is a notebook: sessions die, there is no SLA, and tunnelling it out to
serve production traffic is against the spirit of its terms. Use it for batch
jobs you can restart, not for a lane the server depends on.

### Closed or gone by late 2026

SageMaker Studio Lab (no new users) · Colab Pro for Education (no new signups) ·
Google Cloud $300 trial (**cannot attach GPUs**) · Nebius individual trial
(suspended Jul 2026) · Together AI free trial · RunPod (no free tier) ·
Oracle Always Free (**no GPU shapes**).

### Free inference APIs — no GPU, but it does offload heavy usage

If the goal is "more concurrent capacity", these beat a GPU lane on effort:

| Provider | Free allowance | Notes |
|---|---|---|
| **Groq** | 30 req/min · **1,000 req/day** · 200K tokens/day | OpenAI-compatible, `gpt-oss-120b`, `gpt-oss-20b`, `qwen3.8-27b` |
| Cloudflare Workers AI | **10,000 Neurons/day** | 300 req/min, no training on your data |
| Google Gemini API | Flash-class, ~500 req/day | free-tier prompts may be reviewed by Google |
| OpenRouter `:free` | 20 req/min · 50 req/day (1,000 after a $10 top-up) | ~14 free models |

## The pick

**Modal Starter, `gpu="T4"`** — deployed by `modal-gpu-lane.py` in this folder.
It is the only free option that is a real endpoint: no session cap, scales to
zero so an idle lane costs nothing, and $30/month covers ~50 T4-hours.

**Kaggle** is the zero-card fallback when a bulk job is big enough that 30 h/week
free beats 50 h/month free and the job can tolerate being restarted.

## Deploy

```bash
pip install modal
modal setup
modal secret create hakster-gpu-lane \
  GPU_LANE_TOKEN="$(openssl rand -hex 32)" \
  GPU_LANE_MODEL=qwen2.5-coder:7b
modal deploy server/gpu/modal-gpu-lane.py
```

Then:

```bash
curl -s  https://<your-url>.modal.run/health
curl -s  https://<your-url>.modal.run/v1/chat/completions \
  -H "Authorization: Bearer $GPU_LANE_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"messages":[{"role":"user","content":"hi"}]}'
```

Every response carries `x_gpu_lane.model` and `x_gpu_lane.elapsed_ms`, so GPU
work is distinguishable from CPU work in the ledger.

## Boundaries

- **The agent's model route is untouched.** `cli/src/models/ladder.js`,
  `providers.js`, the `127.0.0.1:11434` relay, the wire model
  `deepseek-v4.1-flash:cloud` and every rate stay exactly as CLAUDE.md §22
  locks them. This lane is a separate opt-in endpoint for batch work.
- The lane refuses any model other than the one it was built with (`400`), the
  same pin-the-model behaviour §22.3 requires of our own endpoint.
- `GPU_LANE_TOKEN` is a secret: create it through `modal secret` / `secret-add`,
  never in a file, argv or chat (§23, §31).
- Nothing here writes into Junkalot or PhantomIDE (§16).
