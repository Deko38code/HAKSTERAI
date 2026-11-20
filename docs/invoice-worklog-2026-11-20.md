# Invoice work log — 2026-11-20 — HaksterAI / PhantomIDE

**Host:** Dell Linux Mint (`/home/ghost/haksterAi`), pm2 process `haksterAi` (port 3579)
**Serving:** existing fleet bots — no new bot token, no pm2 or tunnel change, no downtime.

## 1. Telegram invoice desk (owner-only) — ADD-ON
**Commits:** `b1ba8c6`, `0db2524`, `a56bf2f`, `a5d1c17`, `55e697f` on `main`
**Files:** `server/src/telegramInvoiceBot.js` (new), `server/src/telegramBots.js` (wiring block)

- Reachable from every fleet bot; owner chat only (`TELEGRAM_OWNER_CHAT`). Non-owners get nothing.
- `/invnew`, `/invadd`, `/invshow`, `/invlist`, `/invdisc`, `/invtax`, `/invsent`, `/invpaid`, `/invvoid`
- `/invpdf` renders the invoice with headless Chromium and sends the PDF to the owner's chat — no email.
- `/invset business|owner|email|phone|address|footer|dueDays <value>` fills the invoice header and terms
  (commit `a56bf2f`).
- `/invrec <number> [YYYY-MM]` clones an invoice as a new draft for the given month (default: this month),
  stamps the period on the PDF and refuses a second invoice for the same client period; it keeps
  `recurringOf` back to the source so a retainer run is traceable.
- Ledger `server/data/invoices.json` (atomic write, timestamped `.bak` copies, never deletes);
  action log `server/data/invoice-log.jsonl`; numbering `INV-<year>-<seq>`; money in cents; totals computed.
- Verified in isolation: create → add line → discount → status transitions → void → PDF (44,728 bytes),
  validation rejections, owner denial.

## 2. Market-referenced rate card — ADD-ON
**File:** `server/data/invoice-rate-card.json` (seeded on first use)
**Commands:** `/rates`, `/setrate <key> <amount>`, `/quote <key> [qty]`

- 13 keys with sourced market ranges checked 2026-11-20 (SEO foundation, SEO/local retainers, SEO audit,
  5-page and 10-page builds, care plans, GBP setup/management, simple and custom bots, hourly).
- Owner rates start unset. `/quote` shows a market range only as reference and says so; it never
  presents a market range as the owner's price.

---
**Rate / amount:** _owner to set via `/setrate`_
**Downtime:** none. **Deletions:** none.
