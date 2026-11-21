# Our own SMS gateway

Owner instruction, 2026-11-17: **"build our own sms".** This is the self-hosted
replacement for rented SMS. Two transports need no provider account at all, and the
old Ez Texting path stays available as an optional third.

Box: **Dell** (`ghost-Inspiron-7348`). Nothing here runs on Parrot.

## What exists

| Piece | Path | Job |
| --- | --- | --- |
| Transport router | `server/src/smsGateway.js` | Chooses phone → carrier bridge → Ez Texting and delivers one message |
| Policy + guards | `server/src/notifySms.js` | `SMS_ENABLED`, `/sms on`, single-recipient rule, daily cap, masked log |
| CLI | `server/scripts/sms.js` | `status`, `probe`, `send` (dry run by default), `inbox` |
| Guard suite | `server/scripts/sms-check.js` | 15 read-only checks, no send, no dial |
| Phone setup | `server/scripts/phone-sms-setup.sh` | Generates the Dell→phone key and prints the Termux steps |
| Owner API | `GET /api/sms/status`, `POST /api/sms/send` | Same guarded path over HTTP (owner-authenticated) |

Inbound is unchanged: `POST /api/eztexting/inbound` (public HTTPS, accepts JSON
webhooks and form posts, records to `server/data/inbound-sms-log.jsonl`, forwards to
Telegram only when `EZ_TEXTING_WEBHOOK_SECRET` matches).

## Transport 1 — the phone (real SMS from your own SIM)

The Dell SSHes to the phone and runs `termux-sms-send`. The message leaves from your
phone's SIM: any recipient, no per-message fee, and the inbound half is readable with
`termux-sms-list`.

Requirements on the phone: Termux, `openssh` + `termux-api` packages, and the
**Termux:API** companion app from F-Droid with the SMS permission granted.

Setup: run `./server/scripts/phone-sms-setup.sh` yourself. It never contacts the phone —
it generates `server/data/phone_sms_key` and prints the exact Termux commands for you
to type.

```ini
SMS_PHONE_HOST=10.0.0.147
SMS_PHONE_PORT=8022
SMS_PHONE_USER=u0_a584
SMS_PHONE_KEY=/home/ghost/haksterAi/server/data/phone_sms_key
# or, if key auth is not set up yet:
# SMS_PHONE_PASSWORD_FILE=/home/ghost/haksterAi/server/data/phone_sms_password
SMS_TO=<your mobile, digits only>
```

Safety details that matter:

* The SSH command is built with `execFile` — no local shell, so nothing in the message
  can be interpreted locally.
* The message is base64-encoded before it reaches the phone, so it cannot be read as
  shell syntax there either. `sms-check.js` asserts this with a hostile string.
* Known hosts land in `server/data/phone_known_hosts`, never in `~/.ssh` (owner config).
* Hard timeout (30 s send, 15 s probe) with `SIGTERM`.

## Transport 2 — carrier email-to-SMS bridge

Every major US carrier publishes an email-to-SMS gateway domain (Verizon, AT&T,
T-Mobile and others). Sending `<10-digit>@<gateway domain>` delivers a text. Free, but
only to your own phone, and the domain **must** be the carrier's published one — it is
read from env, never guessed.

```ini
SMS_CARRIER_GATEWAY=<your carrier's gateway domain>
SMS_SMTP_HOST=...
SMS_SMTP_PORT=587
SMS_SMTP_SECURE=false
SMS_SMTP_USER=...
SMS_SMTP_PASS=...
SMS_FROM_EMAIL=alerts@haksterai.com
```

## Transport 3 — Ez Texting (optional, legacy)

```ini
EZ_TEXTING_USER=...
EZ_TEXTING_PASSWORD=...
EZ_TEXTING_FROM=<optional>
```

Kept because it already exists. As of 2026-11-17 the stored credentials answer **401**,
so this transport cannot send until the account gives working API access.

## Shared settings

```ini
SMS_TO=<owner's mobile, digits>          # destination for the own transports
SMS_PROVIDER=auto|phone|carrier-email|eztexting
SMS_ENABLED=false                        # master switch — stays false until verified
SMS_TRIAL_MODE=true                      # only the single authorized number
SMS_ALLOWED_RECIPIENT=<digits>           # that one number
SMS_MAX_MESSAGES_PER_DAY=3               # hard cap, counted from the append-only log
SMS_CUSTOMER_MESSAGING=false             # customers are never texted
```

`SMS_PROVIDER=auto` tries every configured transport in the order above. An unknown
value resolves to **no** transport — a typo never falls through to a different sender.

## Verify without sending

```bash
node server/scripts/sms.js status      # what is configured, masked destination
node server/scripts/sms.js probe       # SSH + Termux check; sends nothing
node server/scripts/sms.js send --text "hello"        # dry run, prints the plan
node server/scripts/sms-check.js       # 15 guard checks
```

A real message needs `SMS_ENABLED=true` **and** `--send`. The daily cap and the
single-recipient rule still apply, so an accidental loop cannot drain your plan.

## Current state — 2026-11-17

* Phone reachable on the LAN (ping 10.0.0.147, ~3 ms) but **sshd refused on 8022** —
  Termux's `sshd` is not running, so the phone transport is built but unverified.
* Carrier bridge not configured (no gateway domain or SMTP account in `server/.env`).
* Ez Texting credentials present, API answers **401**.
* `SMS_ENABLED` is false; no message has been sent by this gateway.
