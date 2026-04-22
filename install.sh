#!/usr/bin/env bash
# install.sh — deploy dobot-server as a systemd --user service with journald logs.
#
# Idempotent: safe to re-run. Does not overwrite user data or secrets.
#
# Pre-flight:
#   - linger enabled for $USER (service must survive logout/reboot)
#   - /usr/bin/node present
#   - ~/.secrets/dobot-server.env present (bot tokens + DB path)
#
# Actions:
#   1. pnpm install --frozen-lockfile
#   2. pnpm run build
#   3. copy systemd/user/dobot-server.service → ~/.config/systemd/user/
#   4. systemctl --user daemon-reload
#   5. systemctl --user enable dobot-server.service
#   6. systemctl --user start OR restart (restart if already active, so re-runs
#      after a rebuild pick up the new dist/)
#   7. print status + tail command

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
UNIT_SRC="$SCRIPT_DIR/systemd/user/dobot-server.service"
UNIT_DST_DIR="$HOME/.config/systemd/user"
UNIT_DST="$UNIT_DST_DIR/dobot-server.service"
ENV_FILE="$HOME/.secrets/dobot-server.env"

# ---- Pre-flight ----

if ! test -e "/var/lib/systemd/linger/${USER}"; then
    echo "ERROR: linger not enabled for user '$USER'." >&2
    echo "Run: sudo loginctl enable-linger $USER" >&2
    exit 1
fi

if [ ! -x /usr/bin/node ]; then
    echo "ERROR: /usr/bin/node not found or not executable." >&2
    echo "The systemd unit hardcodes /usr/bin/node — install Node via the system package manager." >&2
    exit 1
fi

if [ ! -e "$ENV_FILE" ]; then
    echo "ERROR: $ENV_FILE not found." >&2
    echo "Create it with TELEGRAM_NARRATOR_BOT_TOKEN and (optionally) TELEGRAM_IDEA_BOT_TOKEN." >&2
    echo "See .env.example for the full variable list." >&2
    exit 1
fi

if ! test -e "$UNIT_SRC"; then
    echo "ERROR: $UNIT_SRC not found. Run install.sh from a dobot-server checkout." >&2
    exit 1
fi

# ---- Build ----

if ! command -v pnpm >/dev/null 2>&1; then
    echo "ERROR: pnpm not found in PATH." >&2
    exit 1
fi

cd "$SCRIPT_DIR"

echo "==> pnpm install --frozen-lockfile"
pnpm install --frozen-lockfile

echo "==> pnpm run build"
pnpm run build

if [ ! -e "$SCRIPT_DIR/dist/index.js" ]; then
    echo "ERROR: dist/index.js missing after build. Check pnpm run build output." >&2
    exit 1
fi

# ---- Pre-install sanity: systemd unit targets ~/code/dobot-server ----
# The unit hardcodes WorkingDirectory=%h/code/dobot-server. Warn loudly if install.sh
# is being run from a different checkout — the built dist/ here won't be the one
# that systemd launches. Fresh ~/code/dobot-server clones on this VPS are the happy path.
CANONICAL_DIR="$HOME/code/dobot-server"
if [ "$SCRIPT_DIR" != "$CANONICAL_DIR" ]; then
    echo "WARN: install.sh is running from $SCRIPT_DIR" >&2
    echo "      but the systemd unit's WorkingDirectory is $CANONICAL_DIR." >&2
    echo "      systemd will run dist/index.js from $CANONICAL_DIR, not from here." >&2
    echo "      If this is a worktree / non-canonical checkout, either symlink or" >&2
    echo "      edit systemd/user/dobot-server.service before re-running." >&2
fi

# ---- Install unit ----

mkdir -p "$UNIT_DST_DIR"
cp "$UNIT_SRC" "$UNIT_DST"

systemctl --user daemon-reload
systemctl --user enable dobot-server.service

# `enable --now` starts the service ONLY if it's inactive. For re-runs after a code
# update (pnpm run build produced new dist/), we need an explicit restart so the
# running process picks up the new compiled modules.
if systemctl --user is-active --quiet dobot-server.service; then
    systemctl --user restart dobot-server.service
    echo "==> dobot-server.service was active — restarted to pick up new dist/."
else
    systemctl --user start dobot-server.service
    echo "==> dobot-server.service started."
fi

# ---- Status ----

echo ""
systemctl --user status dobot-server.service --no-pager --lines=5 || true

echo ""
echo "Tail logs:    journalctl --user -u dobot-server -f"
echo "Restart:      systemctl --user restart dobot-server"
echo "Stop:         systemctl --user stop dobot-server"
echo "Disable:      systemctl --user disable --now dobot-server"
