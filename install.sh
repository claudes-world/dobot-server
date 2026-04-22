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

# Detect legacy nohup/unmanaged dobot-server process — any `node dist/index.js`
# started outside systemd whose cwd is ~/code/dobot-server and whose exe is a
# real node binary. Empirically narrow (R2 regex `node .*dist/index\.js` was too
# permissive — matched CPC backends like `node apps/server/dist/index.js`, bash
# wrappers whose argv contained the literal string, and Claude subagent prompts):
#   1. Anchored argv: literal `node dist/index.js` (no `.*`) so longer paths miss
#   2. /proc/PID/cwd == ~/code/dobot-server  (wrong-checkout guard)
#   3. /proc/PID/exe resolves to a node binary (not a bash wrapper whose argv
#      happens to contain the string)
CANONICAL_DIR="$HOME/code/dobot-server"
SYSTEMD_PID=$(systemctl --user show dobot-server.service -p MainPID --value 2>/dev/null || echo 0)

# pgrep -f is needed because node's comm is just `node` — argv holds the path.
# Escape the dot so it's a literal (pgrep -f is ERE). The narrow pattern (no `.*`)
# prevents matching `node apps/server/dist/index.js` or other alternate paths.
CANDIDATE_PIDS=$(pgrep -af "node dist/index\.js" | awk '{print $1}' || true)

LEGACY_PIDS=""
for pid in $CANDIDATE_PIDS; do
    # Skip systemd's own MainPID (we're checking for UNMANAGED duplicates)
    if [ "$pid" = "$SYSTEMD_PID" ]; then
        continue
    fi
    # Must be running from the canonical checkout
    if [ ! -r "/proc/$pid/cwd" ]; then
        continue
    fi
    CWD=$(readlink -f "/proc/$pid/cwd" 2>/dev/null || echo "")
    if [ "$CWD" != "$CANONICAL_DIR" ]; then
        continue
    fi
    # Must be an actual node binary — excludes bash wrappers whose argv contains
    # the literal string `node dist/index.js` (e.g. Claude subagent shells, nohup
    # invocation wrappers under PID 1).
    EXE=$(readlink -f "/proc/$pid/exe" 2>/dev/null || echo "")
    case "$EXE" in
        */node|*/node[0-9]*|*/nodejs)
            LEGACY_PIDS="$LEGACY_PIDS $pid"
            ;;
    esac
done
LEGACY_PIDS=$(echo "$LEGACY_PIDS" | xargs)  # trim whitespace

if [ -n "$LEGACY_PIDS" ]; then
    echo "ERROR: Found legacy unmanaged dobot-server node process(es) outside systemd:" >&2
    echo "       PIDs: $LEGACY_PIDS" >&2
    echo "       Each has CWD=$CANONICAL_DIR and exe=node, running dist/index.js." >&2
    echo "       Bot tokens would collide on getUpdates (HTTP 409) + duplicate delivery." >&2
    echo "       Stop the legacy process(es) first: kill -TERM $LEGACY_PIDS" >&2
    echo "       Then re-run ./install.sh" >&2
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

# Enforce secrets-file hygiene: 0600 perms (auto-tighten) + owner must match $USER.
# Ownership drift is a red flag (cross-user contamination or root-owned file), mode
# drift is a common config goof that's safe to auto-fix.
PERMS=$(stat --format='%a' "$ENV_FILE")
if [ "$PERMS" != "600" ]; then
    echo "WARN: $ENV_FILE has permissions $PERMS (expected 600) — tightening to 0600" >&2
    chmod 600 "$ENV_FILE"
fi
OWNER=$(stat --format='%U' "$ENV_FILE")
if [ "$OWNER" != "$USER" ]; then
    echo "ERROR: $ENV_FILE owned by '$OWNER' not '$USER' — refusing to use" >&2
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
