# Profit rates — locked (source of truth: Junkalot.co)

Internal, owner-only. Written 2026-11-22 at the owner's direction ("lock those rates in to our profit
margin data in haksterai admin and phantomide admin dash both always keep those rates"; "add to you
memory … the profit margin and what we charge by request … and haksters mds and phantoms").

This file is a **read-only pointer**. Nothing here may be written back into Junkalot, and none of it is
client-facing (CLAUDE.md §16 project isolation, §19.6 read-only cross-project reads, §25 owner-internal,
§26 locked rates).

## What we charge (locked)

- **$541.3043 per 1M input tokens · $108.2609 per 1M output tokens.**
- The **$249/month plan buys 450,000 input + 50,000 output tokens per month**; usage above that is
  overage at the same rate, so every client stays margin-bearing.
- Derivation: rate = plan ÷ allowance, input valued 5× output — one month of allowance equals the plan
  exactly. Change the plan price in `Junkalot/data/mred-billing.json` and the rate moves with it; no code
  change and no separate rate card.
- **By request:** one Coach turn is metered by its own tokens at that rate. Example — 1,000 in + 200 out
  = **$0.5413 + $0.0217 = $0.5630** for that turn.
- First client is Mr Ed (Susie). Meter at 2026-11-22: **$19.19**, 7.71 % of the $249 plan, pace ≈
  **$252/month**; metering runs from 2026-11-20 and her payment starts 2027-01-01. Owner's own test turns
  are excluded by account.

## What it costs us (the margin)

- Cost base: **`deepseek-v4.1-flash:1017` on Ollama cloud** — billed as a **request quota, not per token**.
- Measured 2026-11-22 at a heavy agent workload and it still lasted the week: **26,511 requests = 83.5 %**
  of a ~31,750 weekly quota (headroom ~5,239). Session: 1,571 = 23.4 %. Week's model mix:
  `deepseek-v4.1-flash:1017` 26,511 · `glm-5.2` 342 · `glm-5.3-flash` 24 · `web search` 20 ·
  `kimi-k2.6` 18 · `glm-5.3` 16 · `gpt-oss:120b` 6.
- Behind the first account: **a second Ollama cloud account** and **Codex Pro (unlimited)**.
- A request inside quota has **no per-token cash cost**, so the margin is the quota share. The per-token
  cost fields stay `null` — no dollar margin is invented (§19.4, §24.7).

## How this project reads it

- Snapshot: `Junkalot/data/profit-rates-snapshot.json` — read it, label it **"source: junkalot.co"**,
  never write to it or into Junkalot (§16, §19.6).
- Index history: `Junkalot/data/profit-rate-history.jsonl` (append-only).
- The demand index (7-day requests/day vs the prior 14 days, bounded 0.5×–3×) is **advice shown to the
  owner**. It never changes a rate, a bill, a route, a model or a plan on its own.
- Applying a meter figure to a client invoice is a human decision (§19.5, §20.4).
