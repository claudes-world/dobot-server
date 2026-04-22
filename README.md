# dobot-server

Unified Telegram bot server — narrator + idea_dobot + future bots via handler modules (grammY + TypeScript + SQLite).

## Deploy

Production deploy is a systemd `--user` service with journald logs.

### First-time install

```bash
# 1. Create the env file with bot tokens
mkdir -p ~/.secrets && chmod 0700 ~/.secrets
cp .env.example ~/.secrets/dobot-server.env
chmod 0600 ~/.secrets/dobot-server.env
$EDITOR ~/.secrets/dobot-server.env   # fill in TELEGRAM_NARRATOR_BOT_TOKEN (+ optional TELEGRAM_IDEA_BOT_TOKEN)

# 2. Enable linger so the service survives logout/reboot (one-time, needs sudo)
sudo loginctl enable-linger $USER

# 3. Run the installer (builds, installs unit, enables, starts)
./install.sh
```

The installer is idempotent — safe to re-run after pulling updates.

### Day-to-day

```bash
# Tail live logs
journalctl --user -u dobot-server -f

# Service status
systemctl --user status dobot-server

# Restart (after a code change + ./install.sh)
systemctl --user restart dobot-server

# Stop
systemctl --user stop dobot-server
```

Historical logs are persisted by journald and accessible via:

```bash
journalctl --user -u dobot-server --since '1h ago'
journalctl --user -u dobot-server --since today
```

## Development

```bash
pnpm install
pnpm run build
pnpm run test
pnpm run start    # runs node dist/index.js with local .env
```
