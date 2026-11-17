#!/usr/bin/env bash
# haksterAI — local half of the phone SMS gateway setup.
#
# This script NEVER contacts the phone. It only:
#   1. generates an SSH key for the Dell -> phone link (if there is none yet),
#   2. prints the exact commands Deke runs in Termux on the phone.
#
# Run it yourself: agents must not type your phone password anywhere.
#
#   ./server/scripts/phone-sms-setup.sh
#
# Nothing is deleted, nothing is overwritten: an existing key is left alone.
set -Eeuo pipefail

DATA="$(cd "$(dirname "$0")/.." && pwd)/data"
KEY="$DATA/phone_sms_key"
KNOWN="$DATA/phone_known_hosts"

mkdir -p "$DATA"
chmod 700 "$DATA"

if [ -f "$KEY" ]; then
  echo "Key already exists, leaving it untouched: $KEY"
else
  ssh-keygen -q -t ed25519 -N '' -C "haksterai-sms-gateway" -f "$KEY"
  chmod 600 "$KEY"
  echo "Created: $KEY"
fi

PUB="$(cat "$KEY.pub")"
HOST_LINE="$(hostname)"

cat <<EOF

── 1. On the phone (Termux) ────────────────────────────────────────────────
Open Termux and run:

  pkg update && pkg install openssh termux-api
  mkdir -p ~/.ssh && chmod 700 ~/.ssh
  echo '$PUB' >> ~/.ssh/authorized_keys
  chmod 600 ~/.ssh/authorized_keys
  passwd                     # set a Termux password (used only by sshpass fallback)
  sshd                       # start sshd on port 8022

Also install the "Termux:API" app from F-Droid — the termux-api package alone is
not enough; termux-sms-send talks to that app. Open it once and allow the SMS
permission when Android asks.

Keep the phone awake while the gateway is in use (Termux wakelock:
  termux-wake-lock
) and note that Android may kill sshd when the phone sleeps. That is why the
carrier-email transport exists as a fallback.

── 2. Verify from the Dell (read-only, sends nothing) ──────────────────────
  ssh -i '$KEY' -p 8022 \\
      -o UserKnownHostsFile='$KNOWN' -o StrictHostKeyChecking=accept-new \\
      u0_a584@10.0.0.147 'command -v termux-sms-send'

or, once the env lines below are in place:

  node server/scripts/sms.js probe

── 3. Add these lines to server/.env yourself ───────────────────────────────
  SMS_PHONE_HOST=10.0.0.147
  SMS_PHONE_PORT=8022
  SMS_PHONE_USER=u0_a584
  SMS_PHONE_KEY=$KEY
  SMS_TO=<your mobile number, digits only>
  SMS_PROVIDER=auto

Then apply the env change (this restarts hakster — do it when no CLI session is
running):

  pm2 restart hakster --update-env

── 4. Prove it without sending ──────────────────────────────────────────────
  node server/scripts/sms.js status
  node server/scripts/sms.js probe
  node server/scripts/sms-check.js

The first real message still needs SMS_ENABLED=true and Deke's explicit go-ahead.
EOF
