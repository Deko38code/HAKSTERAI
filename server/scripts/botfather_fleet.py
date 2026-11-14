#!/usr/bin/env python3
"""
botfather_fleet.py - Fleet-scale BotFather automation.

Creates N bots via @BotFather from a user account, handles username collisions,
captures tokens, optionally sets description/about/commands/photo, and verifies
each token against the Telegram Bot API.

Usage
-----
  # one-off
  python3 botfather_fleet.py --login +15551234567
  python3 botfather_fleet.py --new "Pandemonium Visual AI" PandemoniumVisualBot

  # bulk from a manifest
  python3 botfather_fleet.py --manifest fleet.json

  # generate a manifest skeleton, then create
  python3 botfather_fleet.py --gen 5 --prefix Pandemonium --dry-run
  python3 botfather_fleet.py --gen 5 --prefix Pandemonium --create

  # apply description/about/commands to bots already in fleet.json
  python3 botfather_fleet.py --apply

  # verify tokens
  python3 botfather_fleet.py --verify

State: ~/.hakster/fleet.json (chmod 600), log: ~/.hakster/fleet_log.jsonl
"""
from __future__ import annotations

import argparse
import asyncio
import json
import os
import random
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

API_ID = 2040
API_HASH = "b18441a1ff607e10a989891a5462e627"
SESSION_FILE = os.path.expanduser("~/.hakster/telethon_session")

STATE_DIR = Path(os.path.expanduser("~/.hakster"))
FLEET_FILE = STATE_DIR / "fleet.json"
LOG_FILE = STATE_DIR / "fleet_log.jsonl"
ENV_FILE = Path(__file__).resolve().parent.parent / ".env"

TOKEN_RE = re.compile(r"\b(\d{6,12}:[A-Za-z0-9_-]{30,40})\b")
BF_TIMEOUT = 60

USERNAME_TAKEN = ("already taken", "is already taken", "sorry, this username")
USERNAME_INVALID = ("invalid", "must end in", "can only contain", "too short", "too long")


# --------------------------------------------------------------------------- #
# logging / state
# --------------------------------------------------------------------------- #
def log(event: str, **kw):
    rec = {"ts": datetime.now(timezone.utc).isoformat(timespec="seconds"), "event": event, **kw}
    print(json.dumps(rec), flush=True)
    try:
        STATE_DIR.mkdir(parents=True, exist_ok=True)
        with open(LOG_FILE, "a") as fh:
            fh.write(json.dumps(rec) + "\n")
        os.chmod(LOG_FILE, 0o600)
    except OSError:
        pass


def load_fleet() -> dict:
    if FLEET_FILE.exists():
        try:
            return json.loads(FLEET_FILE.read_text())
        except json.JSONDecodeError:
            log("fleet_corrupt", path=str(FLEET_FILE))
    return {"bots": []}


def save_fleet(fleet: dict):
    STATE_DIR.mkdir(parents=True, exist_ok=True)
    tmp = FLEET_FILE.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(fleet, indent=2))
    os.chmod(tmp, 0o600)
    tmp.replace(FLEET_FILE)


def record_bot(fleet: dict, entry: dict):
    fleet.setdefault("bots", []).append(entry)
    save_fleet(fleet)


def find_bot(fleet: dict, username: str | None = None, name: str | None = None) -> dict | None:
    for b in fleet.get("bots", []):
        if username and b.get("username", "").lower() == username.lower():
            return b
        if name and b.get("name", "").lower() == name.lower():
            return b
    return None


# --------------------------------------------------------------------------- #
# bot api
# --------------------------------------------------------------------------- #
def bot_api(token: str, method: str, params: dict | None = None, timeout: int = 20) -> dict:
    url = f"https://api.telegram.org/bot{token}/{method}"
    data = None
    if params:
        data = urllib.parse.urlencode(params).encode()
    try:
        with urllib.request.urlopen(url, data=data, timeout=timeout) as resp:
            return json.loads(resp.read().decode())
    except urllib.error.HTTPError as e:
        try:
            return json.loads(e.read().decode())
        except Exception:
            return {"ok": False, "description": f"HTTP {e.code}"}
    except Exception as e:
        return {"ok": False, "description": str(e)}



# --------------------------------------------------------------------------- #
# username helpers
# --------------------------------------------------------------------------- #
def sanitize_username(raw: str, max_len: int = 32) -> str:
    u = re.sub(r"[^A-Za-z0-9_]", "", raw or "")
    if len(u) < 5:
        u = (u + "fleetbot")[:max_len]
    if not u.lower().endswith("bot"):
        u = u[: max_len - 3] + "Bot"
    return u[:max_len]


def username_candidates(base: str, n: int = 12) -> list[str]:
    base = sanitize_username(base)
    stem = base[:-3] if base.lower().endswith("bot") else base
    stem = stem[: max(1, 32 - 3 - 3)]
    out = [base]
    suffixes = ["_bot", "FleetBot", "_ai", "HQ", "001", "002"] + [str(random.randint(10, 999)) for _ in range(n)]
    for sfx in suffixes:
        cand = sanitize_username(stem + sfx if sfx.isdigit() else (stem + sfx))
        if cand not in out:
            out.append(cand)
    return out[:n]


# --------------------------------------------------------------------------- #
# telegram session
# --------------------------------------------------------------------------- #
async def get_client(phone: str | None, login: bool):
    from telethon import TelegramClient

    client = TelegramClient(SESSION_FILE, API_ID, API_HASH)
    await client.connect()

    if await client.is_user_authorized():
        me = await client.get_me()
        log("session_ok", user=getattr(me, "username", None) or me.id)
        return client

    if not login:
        await client.disconnect()
        raise SystemExit(
            "Session not authorized. Re-run with: --login <+phone> [--password <2fa>]"
        )

    if not phone:
        await client.disconnect()
        raise SystemExit("--login requires a phone number, e.g. --login +15551234567")

    await client.send_code_request(phone)
    # headless-friendly: TG_CODE env var wins over the interactive prompt
    code = (os.environ.get("TG_CODE") or "").strip()
    if not code:
        code = input("Login code from Telegram: ").strip()
    try:
        await client.sign_in(phone, code)
    except Exception as e:
        if "password" in type(e).__name__.lower() or "SessionPasswordNeeded" in type(e).__name__:
            pw = os.environ.get("TG_2FA") or input("2FA password: ")
            await client.sign_in(password=pw)
        else:
            raise
    me = await client.get_me()
    log("login_ok", user=getattr(me, "username", None) or me.id)
    return client


async def bf_send(conv, text: str) -> str:
    await conv.send_message(text)
    msg = await conv.get_response()
    return msg.text or ""


# --------------------------------------------------------------------------- #
# create one bot
# --------------------------------------------------------------------------- #
async def create_bot(client, name: str, username: str, photo: str | None = None) -> dict | None:
    from telethon.tl.functions.users import GetFullUserRequest

    bf = await client.get_entity("@BotFather")
    cands = username_candidates(username)
    entry: dict = {"name": name, "requested_username": username}

    async with client.conversation(bf, timeout=BF_TIMEOUT) as conv:
        reply = await bf_send(conv, "/newbot")

        if "too many" in reply.lower():
            log("rate_limited", name=name, reply=reply[:300])
            raise RuntimeError("BotFather rate limit - back off and retry later")

        # BotFather asks for the display name
        if "how are we going to call it" not in reply.lower() and "name" not in reply.lower():
            raise RuntimeError(f"unexpected /newbot reply: {reply[:300]}")

        reply = await bf_send(conv, name)

        for attempt, cand in enumerate(cands, 1):
            if "username" not in reply.lower() and "token" not in reply.lower():
                raise RuntimeError(f"expected username prompt, got: {reply[:300]}")

            reply = await bf_send(conv, cand)
            low = reply.lower()

            m = TOKEN_RE.search(reply)
            if m:
                entry.update(
                    username=cand,
                    token=m.group(1),
                    created=datetime.now(timezone.utc).isoformat(timespec="seconds"),
                    attempts=attempt,
                )
                log("bot_created", name=name, username=cand, attempts=attempt)
                if photo:
                    await set_photo(client, bf, cand, photo)
                return entry

            if any(t in low for t in USERNAME_TAKEN):
                log("username_taken", name=name, username=cand)
                continue
            if any(t in low for t in USERNAME_INVALID):
                log("username_invalid", name=name, username=cand, reply=reply[:160])
                continue
            raise RuntimeError(f"unexpected reply for {cand}: {reply[:300]}")

    log("bot_failed", name=name, reason="username candidates exhausted")
    return entry if entry.get("token") else None


async def set_photo(client, bf, username: str, path: str):
    if not os.path.isfile(path):
        log("photo_missing", username=username, path=path)
        return
    try:
        await client.send_message(bf, "/setuserpic")
        await asyncio.sleep(1)
        msgs = await client.get_messages(bf, limit=1)
        await client.send_message(bf, f"@{username}")
        await asyncio.sleep(1)
        await client.send_file(bf, path)
        await asyncio.sleep(2)
        msgs = await client.get_messages(bf, limit=1)
        log("photo_set", username=username, reply=(msgs[0].text or "")[:120] if msgs else "")
    except Exception as e:
        log("photo_error", username=username, error=str(e))


# --------------------------------------------------------------------------- #
# post-create config
# --------------------------------------------------------------------------- #
def apply_config(entry: dict) -> bool:
    token = entry.get("token")
    if not token:
        return False
    ok = True
    if entry.get("description"):
        r = bot_api(token, "setMyDescription", {"description": entry["description"][:512]})
        ok &= bool(r.get("ok"))
        log("set_description", username=entry.get("username"), ok=r.get("ok"))
    if entry.get("short_description") or entry.get("about"):
        val = (entry.get("short_description") or entry.get("about"))[:120]
        r = bot_api(token, "setMyShortDescription", {"short_description": val})
        ok &= bool(r.get("ok"))
        log("set_about", username=entry.get("username"), ok=r.get("ok"))
    cmds = entry.get("commands")
    if cmds:
        payload = json.dumps({"commands": cmds[:100]})
        r = bot_api(token, "setMyCommands", {"commands": payload})
        ok &= bool(r.get("ok"))
        log("set_commands", username=entry.get("username"), ok=r.get("ok"), count=len(cmds))
    return ok


def verify_token(entry: dict) -> dict:
    token = entry.get("token")
    if not token:
        return {"ok": False, "error": "no token"}
    r = bot_api(token, "getMe")
    if r.get("ok"):
        res = r["result"]
        entry["telegram_id"] = res.get("id")
        entry["username"] = res.get("username", entry.get("username"))
        entry["verified"] = datetime.now(timezone.utc).isoformat(timespec="seconds")
        log("verified", username=entry.get("username"), id=res.get("id"))
    else:
        entry["verified"] = None
        log("verify_failed", username=entry.get("username"), error=r.get("description"))
    return r


# --------------------------------------------------------------------------- #
# modes
# --------------------------------------------------------------------------- #
def gen_specs(count: int, prefix: str, names: list[str] | None) -> list[dict]:
    specs = []
    for i in range(count):
        if names and i < len(names):
            name = names[i]
        else:
            name = f"{prefix} {i + 1}"
        uname = sanitize_username(re.sub(r"[^A-Za-z0-9]", "", name) + "Bot")
        specs.append(
            {
                "name": name,
                "username": uname,
                "description": f"{name} - created via BotFather fleet automation.",
                "short_description": f"{name} fleet unit",
                "commands": [{"command": "start", "description": "Activate this bot"}],
            }
        )
    return specs


async def run_create(args):
    fleet = load_fleet()

    if args.manifest:
        spec = json.loads(Path(args.manifest).read_text())
        specs = spec.get("fleet") or spec.get("bots") or []
    elif args.new:
        specs = [
            {
                "name": args.new[0],
                "username": args.new[1] if len(args.new) > 1 else sanitize_username(args.new[0] + "Bot"),
                "description": args.description,
                "short_description": args.about,
                "photo": args.photo,
            }
        ]
    elif args.gen:
        specs = gen_specs(args.gen, args.prefix, args.names)
    else:
        raise SystemExit("nothing to create: pass --new, --manifest, or --gen")

    if args.dry_run:
        print(json.dumps({"would_create": specs}, indent=2))
        return

    client = await get_client(args.login, bool(args.login))
    try:
        for i, s in enumerate(specs, 1):
            name, uname = s["name"], s.get("username") or sanitize_username(s["name"] + "Bot")
            existing = find_bot(fleet, name=name) or find_bot(fleet, username=uname)
            if existing and existing.get("token"):
                log("skip_existing", name=name, username=existing.get("username"))
                continue
            log("creating", index=i, total=len(specs), name=name, username=uname)
            try:
                entry = await create_bot(client, name, uname, s.get("photo") or args.photo)
            except RuntimeError as e:
                log("create_error", name=name, error=str(e))
                if args.sleep:
                    await asyncio.sleep(args.sleep)
                continue

            if not entry or not entry.get("token"):
                continue

            entry.update(
                description=s.get("description") or args.description,
                short_description=s.get("short_description") or args.about,
                commands=s.get("commands"),
                photo=s.get("photo") or args.photo,
            )
            record_bot(fleet, entry)
            verify_token(entry)
            if not args.no_config:
                apply_config(entry)
            save_fleet(fleet)
            if args.sleep:
                await asyncio.sleep(args.sleep)
    finally:
        await client.disconnect()

    ok = [b for b in fleet["bots"] if b.get("token")]
    print(f"\nFleet total: {len(ok)} bots with tokens -> {FLEET_FILE}")


async def run_apply(args):
    fleet = load_fleet()
    n = 0
    for b in fleet.get("bots", []):
        if apply_config(b):
            n += 1
    save_fleet(fleet)
    print(f"Applied config to {n} bots")


def run_verify(_args):
    fleet = load_fleet()
    good = bad = 0
    for b in fleet.get("bots", []):
        if verify_token(b).get("ok"):
            good += 1
        else:
            bad += 1
    save_fleet(fleet)
    print(f"Verified ok={good} failed={bad}")


def run_export(args):
    """Push fleet tokens into server/.env as TELEGRAM_BOT_TOKEN_N (idempotent)."""
    env_path = Path(args.env_file or ENV_FILE)
    if not env_path.exists():
        raise SystemExit(f"no .env at {env_path}")

    lines = env_path.read_text().splitlines()
    have = set()
    used_idx = set()
    for ln in lines:
        m = re.match(r"^\s*TELEGRAM_BOT_TOKEN_(\d+)\s*=\s*(\S+)", ln)
        if m:
            used_idx.add(int(m.group(1)))
            have.add(m.group(2).strip())

    fleet = load_fleet()
    new_rows, skipped = [], 0
    for b in fleet.get("bots", []):
        tok = (b.get("token") or "").strip()
        if not tok or tok in have:
            skipped += 1
            continue
        idx = max(used_idx, default=0) + 1
        used_idx.add(idx)
        have.add(tok)
        b["env"] = f"TELEGRAM_BOT_TOKEN_{idx}"
        new_rows.append((f"TELEGRAM_BOT_TOKEN_{idx}", tok, b.get("username") or b.get("name")))

    if not new_rows:
        print(f"Nothing to export - {skipped} fleet token(s) already present in {env_path}")
        return

    if args.dry_run:
        for k, v, who in new_rows:
            print(f"would add {k}  ({who})  {v[:10]}...{v[-4:]}")
        return

    # insert after the last existing TELEGRAM_BOT_TOKEN_ line so the block stays together
    last = max((i for i, ln in enumerate(lines) if ln.strip().startswith("TELEGRAM_BOT_TOKEN_")), default=None)
    block = [f"{k}={v}" for k, v, _ in new_rows]
    if last is None:
        lines.extend(["", "# Telegram Bot Tokens (BotFather)"] + block)
    else:
        lines[last + 1:last + 1] = block

    backup = env_path.with_suffix(env_path.suffix + ".bak")
    backup.write_text(env_path.read_text())
    env_path.write_text("\n".join(lines) + "\n")
    save_fleet(fleet)

    for k, v, who in new_rows:
        print(f"added {k}  ({who})  {v[:10]}...{v[-4:]}")
    print(f"\n{len(new_rows)} token(s) written to {env_path}\nbackup: {backup}")
    print("restart the server for them to load: pm2 restart hakster-server --update-env")


def run_list(_args):
    fleet = load_fleet()
    bots = fleet.get("bots", [])
    if not bots:
        print("fleet.json is empty")
        return
    print(f"{'NAME':<28} {'USERNAME':<26} {'ID':>12}  TOKEN")
    for b in bots:
        tok = b.get("token", "")
        masked = (tok[:10] + "..." + tok[-4:]) if tok else "-"
        uname = b.get("username") or "-"
        uname = ("@" + uname) if uname != "-" else "-"
        print(f"{b.get('name','')[:27]:<28} {uname[:25]:<26} "
              f"{str(b.get('telegram_id','-')):>12}  {masked}")


async def run_doctor(_args):
    """Report whether the tool can actually create bots right now."""
    out = {"session_file": SESSION_FILE, "fleet_file": str(FLEET_FILE)}
    try:
        import telethon  # noqa: F401
        out["telethon"] = telethon.__version__
    except ImportError:
        out["telethon"] = None
        out["verdict"] = "telethon missing -> pip install telethon"
        print(json.dumps(out, indent=2))
        return
    try:
        client = await get_client(None, False)
    except SystemExit as e:
        out["session_authorized"] = False
        out["verdict"] = str(e)
        print(json.dumps(out, indent=2))
        return
    try:
        me = await client.get_me()
        out["session_authorized"] = True
        out["account"] = getattr(me, "username", None) or me.id
        out["account_name"] = " ".join(x for x in [me.first_name, me.last_name] if x)
        try:
            ents = await client.get_entity("BotFather")
            out["botfather_reachable"] = True
            out["botfather_id"] = ents.id
        except Exception as e:
            out["botfather_reachable"] = False
            out["botfather_error"] = str(e)
            out["hint"] = "open https://t.me/BotFather once, then retry"
    finally:
        await client.disconnect()
    bots = load_fleet().get("bots", [])
    out["fleet_size"] = len(bots)
    out["fleet_verified"] = sum(1 for b in bots if b.get("verified"))
    out["verdict"] = "ready to create bots" if out.get("botfather_reachable") else "session ok, BotFather not reachable"
    print(json.dumps(out, indent=2))


def build_parser():
    p = argparse.ArgumentParser(description="BotFather fleet automation")
    p.add_argument("--login", metavar="PHONE", help="authorize the Telegram session (interactive code)")
    p.add_argument("--new", nargs="+", metavar=("NAME", "USERNAME"), help="create one bot")
    p.add_argument("--manifest", help="JSON manifest with a 'fleet' array")
    p.add_argument("--gen", type=int, metavar="N", help="generate N bot specs")
    p.add_argument("--prefix", default="Fleet", help="name prefix for --gen")
    p.add_argument("--names", nargs="*", help="explicit names for --gen")
    p.add_argument("--create", action="store_true", help="create generated specs (with --gen)")
    p.add_argument("--dry-run", action="store_true", help="print specs, create nothing")
    p.add_argument("--apply", action="store_true", help="apply description/about/commands")
    p.add_argument("--verify", action="store_true", help="verify all tokens via getMe")
    p.add_argument("--export", action="store_true", help="write new fleet tokens into .env as TELEGRAM_BOT_TOKEN_N")
    p.add_argument("--env-file", help="override target .env path")
    p.add_argument("--list", action="store_true", help="list the fleet")
    p.add_argument("--no-config", action="store_true", help="skip post-create config")
    p.add_argument("--description", help="default long description")
    p.add_argument("--about", help="default short description")
    p.add_argument("--photo", help="default avatar image path")
    p.add_argument("--sleep", type=float, default=3.0, help="seconds between bots (default 3)")
    p.add_argument("--doctor", action="store_true", help="check session + BotFather reachability")
    return p


def main():
    args = build_parser().parse_args()

    if args.doctor:
        return asyncio.run(run_doctor(args))
    if args.list:
        return run_list(args)
    if args.verify:
        return run_verify(args)
    if args.export:
        return run_export(args)
    if args.apply:
        return asyncio.run(run_apply(args))
    if args.login and not (args.new or args.manifest or args.gen):
        async def _auth():
            c = await get_client(args.login, True)
            await c.disconnect()
        return asyncio.run(_auth())
    if args.gen and not args.create and not args.dry_run:
        args.dry_run = True
    return asyncio.run(run_create(args))


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        print("\ninterrupted", file=sys.stderr)
        sys.exit(130)
