# Domain desk bot (fleet slot 8)

The marketplace's domain bot. It answers one question honestly — *is this name
registered?* — and suggests short, easy-to-spell names for the product roster.
It never buys, reserves, holds, or promises a name.

Added 2026-11-08. Not live yet: the bot needs a token from BotFather and one
restart. Everything else is finished and tested.

## Files

| File | Role |
| --- | --- |
| `server/src/telegramDomainBot.js` | the bot: RDAP checks, name ideas, waitlist, launch status |
| `server/src/telegramBots.js` | role `TELEGRAM_BOT_TOKEN_8` (`domains`), dispatch, startup line |
| `server/scripts/telegram-fleet.js` | BotFather hint + `setMyCommands` list for domain bots |
| `server/scripts/domain-bot-selftest.js` | 14-case self-test, no token required |
| `data/marketplace-status.json` | `state: "coming-soon"` or `"open"`, plus one note line |
| `data/domain-waitlist.json` | created on the first `/waitlist`; emails only, mode 0600 |

Backups taken before editing: `telegramBots.js.bak-domain-bot-<utc>`,
`telegram-fleet.js.bak-domain-bot-<utc>` (byte-identical, same SHA-256 as the originals).

## Commands

| Command | What happens |
| --- | --- |
| `/check <name>` | One registry (RDAP) lookup. Registered / no record / unknown / fake suffix. Never guesses. |
| `/find <keyword>` | Up to six short names on `.com`, checked one at a time, 250 ms apart. |
| `/tlds` | The suffixes the desk quotes. |
| `/market` | Opens the marketplace mini app (shared handler); the desk's own status text is one line behind it. |
| `/waitlist <email>` | Appends to `data/domain-waitlist.json`. Nothing charged, no name held. |
| `/help` | The list above. |

Rate limit: 8 lookups per chat per minute, then a plain "give it a minute".
Lookup cache: 10 minutes per name, 500 entries.

## Where the answers come from

`https://rdap.org/domain/<name>` — the public bootstrap to each registry's RDAP
service. `404` means no registration record; `200` means registered, and the
reply shows the creation date and registrar on record when the registry
publishes them. The IANA TLD list (`data.iana.org/TLD/tlds-alpha-by-domain.txt`,
cached 24 h) is what separates *not registered* from *not a real suffix*.

No paid API, no key, no scraping, no credentials.

## Activating it (owner steps)

1. `node server/scripts/telegram-fleet.js --hint domains` — the BotFather steps.
2. In @BotFather: `/newbot`, display name `domains`, a username like `haksterdomains_bot`.
3. Give the token to the agent for verification only:
   `node server/scripts/telegram-fleet.js --add --name domains --job "marketplace domain desk" --token <token>`
   This runs `getMe`, records the sub-agent in `data/telegram-subagents.json`, and sets the
   command list. It prints the exact `TELEGRAM_BOT_TOKEN_8=…` line.
4. Paste that line into `server/.env` — the owner's file, never an agent's edit.
5. `pm2 restart hakster --update-env` (only when no CLI session is running).
6. Send `/start` and `/check example.com` in the new bot. Both must answer before it counts as working.

## Verification already done

```
node server/scripts/domain-bot-selftest.js      → 14/14 passed
```

Live registry results from that run: `example.com` → registered (IANA, 1995-08-14),
`haksterai.com` → registered (Tucows, 2026-07-05), a random `selftest-*.com` → no
record, `selftest.zzz` → rejected as not a real suffix. The desk also ignores
`/ports`, `/security` and `/recon`, so it cannot swallow another bot's commands.

## What it deliberately does not do

- No purchase, no reservation, no cart. Availability is a registrar's answer at
  checkout, and every reply says so.
- No fake prices, no invented "premium" values, no stock counts.
- No third-party domain-data service, so nothing to bill and no key to leak.
- It does not touch `server/.env`, tunnels, pm2 state, or any other bot.
