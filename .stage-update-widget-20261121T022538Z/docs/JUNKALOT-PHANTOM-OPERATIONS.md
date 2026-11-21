# Junkalot + Mr Ed — Phantom operations runbook

_For: `@phantom` (HaksterAI). Written 2026-11-07 from facts verified against the running
system. This is the "how I do it without breaking anything" procedure for Junk-A-Lot
(junkalot.co) and its AI coach, Mr Ed._

Read `docs/PHANTOM-SELF-CARE.md` first. This file assumes those rules — append-only brain,
backup before every edit, never touch config, never restart a service without the owner's
explicit go-ahead.

---

## 1. Ground rules (these override convenience)

- **Never delete anything.** No `rm`, no cleanup, no `git reset`, no `git checkout --`, no
  reverting a file to "clean up". Junkalot has an absolute no-deletion rule in both copies.
- **Two copies, both must stay healthy.** Master `/home/ghost694/junkalot` (live, :5006) and
  editing copy `/home/ghost694/workspace/dekekenneth840@gmail.com/junkalot` (:5007). Patch
  forward; never replace the master with an older workspace snapshot.
- **You cannot restart the service.** It is `junkalot.service`, needs sudo, and the agent has
  none. Deke runs: `ssh -t parrot 'sudo systemctl restart junkalot'`. You prepare, build and
  verify; you report "ready — needs your restart"; you then verify live after he does it.
- **Never touch** `/etc/cloudflared/config.yml`, `~/.cloudflared/**`, `server/.env`, any
  `.env*` file, `next.config.js` `distDir` beyond the per-build naming described below, pm2, or
  any owner config.
- **The brain is append-only.** `docs/junkalot-brain-current.md` gets a new dated section; it is
  never rewritten, consolidated, or trimmed. Backup, confirm, append, verify the file grew.
- **Edit the coach prompt and the brain together.** If a number or promise changes in
  `COACH_SYSTEM`, the same task must append the matching dated entry to the brain in **both
  copies**. They must never disagree.

---

## 2. Topology (verified 2026-11-07)

| Thing | Value |
| --- | --- |
| Master (live) | `/home/ghost694/junkalot`, git HEAD `6b2a94c` |
| Editing copy | `/home/ghost694/workspace/dekekenneth840@gmail.com/junkalot`, HEAD `e3a2393` |
| Service | `junkalot.service`, `ExecStart=/bin/node node_modules/next/dist/bin/next start -p 5006` |
| Live process | MainPID 388432, active since 2026-11-07 11:58:13 EST |
| Ports | :5006 master/live, :5007 editing copy |
| Public | `https://junkalot.co` via Cloudflare tunnel (never touch the tunnel) |
| Framework | Next.js App Router, `next build` / `next start` |
| Per-build distDir | master `.next-junkalot-ed-value-20261107T164011Z`, workspace `.next-junkalot-ed-value-ws-20261107T164011Z` |
| Brain | `docs/junkalot-brain-current.md` — 35,680 B (2026-11-07), read per request (edits are live without a rebuild) |
| Value-record template | `docs/coach-value-record-template.md` (2,402 B) |
| Invoice ledger | `/home/ghost694/.phantom-invoices.json` (7,493 B) |
| Agreement | `/home/ghost694/junkalot-invoices/AGREEMENT-JAL-2026-11-07.md` (4,259 B) |
| Work record (Dell) | `/home/ghost/backups/junkalot-work-record-2026-11-07.md` |
| Verify helper | `/tmp/verify_payoff.sh` pattern (below); bridge key `~/.config/junkalot-payoff-bridge.key` |
| Env files | master has `.env.local` + `.env.production.local`; **the editing copy has neither**, so verification runs from master |

---

## 3. The money record — the numbers, and where they live

These are the only approved figures. They are hardcoded, not guessed:

| Fact | Value |
| --- | --- |
| Base website build | $15,000 |
| Photo maintenance adjustment | $375.99 |
| **Build total** | **$15,375.99** |
| Confirmed credits | $2,249 ($2,000 confirmed owner work + one confirmed $249 care payment) |
| **Live balance** | **$13,126.99** |
| Schedule | 53 payments from 2027-01-01: 52 × $249 + final $178.99 in May 2031 = $13,126.99 exactly |
| Monthly care plan | $249, capped there until Deke changes it; 30 days' notice for any change |
| What $249 buys | ~1.7–2.9 h of ordinary 2026 US developer time ($85–$150/h), ~2.4 h mid-market |
| Delivered work, 2026 replacement cost | **$39,000–$84,000, ~$54,000 mid-market** — the $15,375.99 contract is ~28% of mid-market |
| Effort | ~511 h (honest band 460–560 h) across 11 workstreams |
| What was delivered | 15 site pages, 19 backend services, ~9,400 lines, 54 production builds, 67 recorded changes |

Where each lives:

- `src/app/api/ai-terminal/route.ts:18` — `COACH_SYSTEM` (starts at line 18; the
  `WHAT THIS SITE COST TO BUILD — OWNER-APPROVED VALUE RECORD` block begins at `:72`); `:78` the
  "$249 buys about 1.7 to 2.9 hours" line; `:142` `COACH_SYSTEM_TAIL`; `:226` reads the brain per
  request; `:333` assembles `COACH_SYSTEM + brain + COACH_SYSTEM_TAIL`.
- `src/app/api/internal/payoff-summary/route.ts:10-17` — `OWNER_CONFIRMED_PAID_WORK = 2000`,
  `BASE_WEBSITE_BUILD_TOTAL = 15000`, `PHOTO_MAINTENANCE_ADJUSTMENT = 375.99`,
  `MONTHLY_RATE = 249`, `PAYMENT_BUTTON_START = 2027-01-01T08:00:00.000Z`; `:53-59` the
  reconciliation; `:68` the response.
- `src/app/api/admin/invoices/route.ts:17-20,77-89` — the same constants and the same
  reconciliation for the admin invoice view.
- PhantomIDE invoice agent prompt (`~/phantomide/phantom-ide.html` and `~/phantom-ide.html`,
  `launchInvoiceAgentInTerminal`) — carries the authoritative record block dated 2026-11-07.

**Never let a paid month count twice.** A confirmed monthly payment reduces the *balance*
(`remainingBalance = remaining − monthlyCredited`) and is not also added as an extra installment
month. That was a real bug; see §4.

---

## 4. What was fixed this cycle (so you don't reintroduce it)

1. **Double-counted monthly payments.** `payoff-summary` counted a confirmed $249 payment toward
   `confirmedPaid` *and* still scheduled the original number of installments. Fixed by crediting
   monthly payments against `remainingBalance` and computing `totalPaymentMonths` from the
   reduced balance. Admin invoices does the same.
2. **Stale balances.** Older copy said "$13,000 payoff / $13,375.99 basis". Live, correct
   figures are $15,375.99 total and $13,126.99 remaining. The coach prompt carries an explicit
   line reconciling the old wording so it can never be quoted as current.
3. **Coach had no owner value record.** Susie's coach would improvise about cost and value. It
   now has the hardcoded block (§3) plus guardrails: never inflate, never call it an appraisal,
   never quote it to a customer, never turn it into a pitch.
4. **Brain and prompt could drift.** A standing rule (home `AGENTS.md`, "Junkalot coach
   training") requires updating both in the same task and appending — never rewriting — dated
   entries in both copies.
5. **Build collisions.** Each production build gets its own `distDir` name with a UTC stamp, so a
   new build never overwrites the assets the running server is still serving.

---

## 5. How to patch Mr Ed without breaking him

Work from the master copy (`/home/ghost694/junkalot`) unless Deke says otherwise. Every step is
reversible; nothing is deleted.

### Step 0 — read the current state

```bash
cd /home/ghost694/junkalot
grep -n "OWNER-APPROVED VALUE RECORD\|COACH_SYSTEM\|WHAT \$249 A MONTH REALLY BUYS" src/app/api/ai-terminal/route.ts
wc -c src/app/api/ai-terminal/route.ts docs/junkalot-brain-current.md
```

### Step 1 — unique timestamped backup (and prove it)

```bash
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
cp -p src/app/api/ai-terminal/route.ts src/app/api/ai-terminal/route.ts.bak-ed-$STAMP
ls -l src/app/api/ai-terminal/route.ts.bak-ed-$STAMP   # must print a real file
```

### Step 2 — patch with Python, anchored, abort-on-mismatch

`sed` silently no-ops on multi-line text — use Python, and make the script refuse to write unless
the anchor matches exactly once. Write the script locally, `scp` it, run it:

```python
import shutil, sys, time
p = '/home/ghost694/junkalot/src/app/api/ai-terminal/route.ts'
s = open(p, encoding='utf-8').read()
old = 'exact existing text'      # copy it from the file, verbatim
new = old + 'exact new text'     # additive whenever possible
if s.count(old) != 1:
    sys.exit(f'ABORT: anchor matched {s.count(old)} times')
bak = p + '.bak-ed-' + time.strftime('%Y%m%dT%H%M%SZ')
shutil.copy2(p, bak)
assert __import__('os').path.getsize(bak) == len(s.encode())
after = s.replace(old, new, 1)
open(p, 'w', encoding='utf-8').write(after)
assert len(after) > len(s), 'file did not grow'
print('PATCHED', len(s), '->', len(after), 'backup', bak)
```

### Step 3 — syntax check, then the real check (build)

```bash
cd /home/ghost694/junkalot
node --check src/app/api/ai-terminal/route.ts 2>/dev/null || true   # .ts may not parse; see below
npx tsc --noEmit -p . 2>/dev/null || true
```

`node --check` does not understand TypeScript. The authoritative check is the production build:

```bash
cd /home/ghost694/junkalot
# give this build its own directory so the live assets are untouched
grep -n distDir next.config.js
npm run build            # run in background if the box is busy; it takes minutes
```

If the build fails, restore the backup (copy back — the backup stays on disk) and stop.

### Step 4 — verify the numbers before anyone restarts

The master copy has the env files. Run a throwaway server on 5098 and query the authenticated
payoff bridge:

```bash
cd /home/ghost694/junkalot
node --env-file=.env.local --env-file=.env.production.local \
  node_modules/next/dist/bin/next start -p 5098 >/tmp/jl-verify.log 2>&1 &
PID=$!
for i in $(seq 1 60); do curl -s -m 2 -o /dev/null http://127.0.0.1:5098/ && break; sleep 1; done
curl -s -H "x-junkalot-payoff-bridge: $(cat ~/.config/junkalot-payoff-bridge.key)" \
  http://127.0.0.1:5098/api/internal/payoff-summary | python3 -m json.tool
curl -s -o /dev/null -w 'home=%{http_code}\n' http://127.0.0.1:5098/
kill $PID
```

Assert exactly:

```
total 15375.99 · confirmedPaid 2000 · monthlyCredited 249 · remaining 13126.99
totalPaymentMonths 53 · payoff 52 × 249 + 178.99 = 13126.99 · estimated payoff May 2031
```

Also grep the compiled route in the new distDir for the value-record text — if it is not in the
compiled chunk, the prompt did not ship:

```bash
grep -rl "OWNER-APPROVED VALUE RECORD" .next-junkalot-ed-value-* | head
```

### Step 5 — hand off the restart

Report: files changed, backup paths, build result, the asserted numbers, and the exact command:

```bash
ssh -t parrot 'sudo systemctl restart junkalot'      # Deke runs this, not the agent
```

### Step 6 — verify live after the restart

```bash
systemctl show junkalot -p MainPID -p ActiveState --no-pager
curl -s -o /dev/null -w 'public=%{http_code}\n' https://junkalot.co/
curl -s https://junkalot.co/ | grep -o '/_next/static/[A-Za-z0-9_-]\{8,\}' | head -1   # buildId
curl -s -H "x-junkalot-payoff-bridge: $(cat ~/.config/junkalot-payoff-bridge.key)" \
  http://127.0.0.1:5006/api/internal/payoff-summary | python3 -m json.tool
```

The public buildId must match the new build, `https://junkalot.co/` must be 200, and the live
numbers must equal step 4. Only then say it is live.

### Step 7 — train Mr Ed (same task, both copies)

Append a dated section to `docs/junkalot-brain-current.md` in the master **and** the editing copy:
what changed, the verified live state, the date. Backup first, append only, confirm the file grew,
never rewrite an earlier entry. If a promise, price, feature, or plan changed, update the coach
facts in `route.ts` in the same task — prompt and brain must match word for word on the numbers.

---

## 6. Abort conditions — stop and report, do not improvise

- Anchor matched 0 or 2+ times → the file changed under you; re-read and rewrite the patch.
- Build fails or a route 500s → restore the `.bak`, rebuild, report the exact error.
- Payoff numbers do not equal §3 → do **not** restart; find the double count or the stale
  constant first.
- Service will not start after a restart → leave the last good distDir in place, report the
  journal lines; never "fix" it by editing `.env` or the tunnel.
- Anything that seems to need deleting a file, rewriting the brain, or touching config → stop.
  Name the exact file, the exact diff, and the consequence, and wait for Deke.

---

## 7. Known open items (do not present these as done)

- ~~The coach value record says "27.5 KB owner knowledge base"; the brain is now 35,680 B.~~
  **Fixed 2026-11-07** (owner-approved): the record now reads "a 35,000+ byte owner knowledge base
  that grows with every change", a floor that stays true as the brain grows rather than a figure
  that goes stale on the next entry. Never put an exact byte count there again.
- The invoice/payment prompts in both PhantomIDE copies were corrected on 2026-11-07: the stale
  `$13,000 payoff / $13,375.99 basis` sentence now reads `$15,000 build total / $15,375.99 basis`
  with the `$13,126.99` live balance. Verified 0 remaining stale markers in both files.
- The $249 Pay button is intentionally hidden until 2027-01-01 (`PAYMENT_BUTTON_START`).
- Susie must press **Connect business Gmail** before mail notices flow. That is her action, not a
  code fix.
- Paid-user publishing/hosting and Stripe product verification are still open items tracked in
  `/home/ghost/AGENTS.md`; never describe them as live.

---

## 8. Quick reference card

```
master      /home/ghost694/junkalot                 :5006   live
workspace   /home/ghost694/workspace/dekekenneth840@gmail.com/junkalot :5007
service     junkalot.service        restart = Deke only (sudo)
coach       src/app/api/ai-terminal/route.ts   COACH_SYSTEM ~:18, value record :72
brain       docs/junkalot-brain-current.md     append-only, both copies
payoff      src/app/api/internal/payoff-summary/route.ts   constants :10-17
admin       src/app/api/admin/invoices/route.ts :17-20, :77-89
numbers     15,375.99 total · 2,249 credited · 13,126.99 balance · 53 × $249 (last 178.99) · May 2031
value       $39,000-$84,000 replacement (mid ~$54,000) for ~511 h of work
rule        backup → anchor-checked python patch → build → temp-server assert → Deke restarts → live verify → append brain
```

---

## 9. Added 2026-11-07 — booking speed and Stripe coaching

- **Booking is the fast path, not calling.** The confirmation screen no longer promises a callback
  ("we will call you within the hour"). It uses the API's real `emailSent` flag: emailed team →
  "Booked — we have alerted Susie and we will answer within the hour."; not emailed → tell the
  customer to call so it is not missed. `src/app/booking/page.tsx` success screen, review-step
  footnote, and Same-Day card.
- The Same-Day card changed from "Call before noon!" with a Call Now link to "Need it gone today?
  Book before noon and we will answer within the hour" with a **Book Now** button that starts the
  wizard. The in-wizard same-day notice and the recommended-card bullet say the same thing. The
  phone numbers stay as a real fallback — never remove them, never present calling as faster.
- Mr Ed's chat facts (`src/app/api/chat/route.ts`) match: same-day service is described as
  book-before-noon with an answer within the hour, not "call before noon".
- The same claim was corrected site-wide so the message cannot contradict the booking flow:
  home-page service tile (`src/app/page.tsx`), about-page same-day tile
  (`src/app/about/page.tsx`), and the same-day blog post (`src/app/blog/[slug]/page.tsx`).
  Phone numbers remain as a genuine alternative — the rule is "never present calling as faster",
  not "hide the phone".
- The AI estimate call in `src/app/api/booking/route.ts` now has
  `signal: AbortSignal.timeout(2500)` — a slow model can never delay a booking. The booking is
  still written to the database and the team email still sends; only the optional estimate is
  dropped when slow.
- Mr Ed carries a `GETTING PAID ONLINE WITH STRIPE` block in `COACH_SYSTEM`: why card payment
  matters, how Susie signs up herself, ~2.9% + 30¢ standard US rate with no monthly fee (tell her
  to check stripe.com/pricing), what it unlocks, that Deke connects and tests it before any
  button is enabled, and that card payment is **not live** until that test passes. It must never
  claim payments are live, invent a fee or payout date, or accept card details in chat.
- Both copies patched, both brain copies appended (see the dated entry in
  `docs/junkalot-brain-current.md`).
