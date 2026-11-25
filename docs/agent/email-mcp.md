# Email MCP — reading Thunderbird and Gmail from the agent

Server: `server/src/agent/email-mcp-server.cjs` (stdio JSON-RPC, MCP).
Roster entry: `.hakster/mcp.json` → `email` (tier 2, lazy: tools are listed, the process
spawns on the first call, so it costs nothing on a turn that never touches mail).
Probe: `node server/__smoke__/email-mcp-probe.mjs [searchTerm]` — real handshake, real mail.

## Three sources, one tool surface

| source | state | credentials |
|---|---|---|
| `thunderbird` | works out of the box | none — reads the local profile's mbox store read-only |
| `gmail` | live read + send | the project's existing Gmail OAuth connection (`gmail.readonly`, `gmail.send`) |
| `imap` | live read + send | accounts in `~/.hakster/mail` (AES-256-GCM, 0600) added from the admin mail panel |

The local store is as fresh as Thunderbird's last sync. Live delivery needs one of the two
credential paths below.

## Tools

- `email_status` — what is actually usable right now. Call it before claiming mail access.
- `email_folders` — folders with size and last-updated time.
- `email_recent` — newest messages. `source`, `folder`, `limit`; gmail also takes a `query`.
- `email_search` — thunderbird: full-text over the mbox store, bounded by `maxScanMb`
  (default 64) so it always returns; gmail: Gmail query syntax.
- `email_read` — full text body plus headers and attachment **names/sizes** (never content).
  Pass the `ref` from a list/search: `tb:<folder>:<byteOffset>` or `gmail:<messageId>`.
- `email_send` — sends via the Gmail connection unless another account is named. Outward
  action: confirm recipient and content before calling.

## Making the live Gmail path work (one owner action, once)

1. Gmail API is already configured on the server (`GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`
   / `GMAIL_MONITOR_REDIRECT_URI=https://haksterai.com/api/admin/gmail/callback`).
2. Open `https://haksterai.com/admin/email` (owner only) and press **Connect Gmail · inbox + send**.
3. The refresh token is stored encrypted at `~/.hakster/gmail-monitor/connection-<hash>.json`
   (AES-256-GCM, key derived from `GOOGLE_CLIENT_SECRET`). The MCP server reads it in-process;
   it is never printed, logged or copied.

If Google shows an unverified-app or test-user screen, add the account as a test user on the
OAuth client or complete verification — that is a Google-side setting, not a server defect.

## Alternative: IMAP/SMTP account

Add the account in the admin mail panel (or `~/.hakster/mail` store). Gmail requires an app
password when the account has 2FA. The password is entered through the panel or
`/home/ghost/bin/secret-add`, never through chat.

## Reading rules

- Bodies are truncated to 20 000 characters; attachment content is never returned.
- Nothing logs a token, a password or a full body.
- Scanning is windowed (4 MB windows, 2 MB overlap) newest-first, so a 3.9 GB INBOX answers
  `recent` in ~2.5 s instead of walking the file.

## Verification (measured 2026-11-26)

`node server/__smoke__/email-mcp-probe.mjs invoice` → 12/12 checks, local store 17 folders /
9 228.9 MB, `email_recent` 2.7 s, `email_read` 109 ms, `email_search` 1.5 s.
Roster entry verified through the project's own loader (`testServerConfig`): ok, 6 tools, 522 ms.

The live server picks the entry up at its next natural start — a restart is not required to
use the probe, and must not be forced while a CLI session is attached (§45).
