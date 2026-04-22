# Changelog

All notable changes to dobot-server are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0] - 2026-04-22

### Added

- Initial shared Telegram bot server hosting `@narrator_dobot` (and `@idea_dobot` when `TELEGRAM_IDEA_BOT_TOKEN` is set).
- `bot-factory` (grammY) so one process can host multiple `Bot` instances, each with its own handler wiring.
- Handler modules:
  - `narrator` — classify (Haiku subprocess) → tone/shape/length selection → claude-subprocess rewrite → delivery (md-speak TTS + shared link).
  - `narrator-callback` — length-keyboard callback handler with timeout-rebuild on restart.
  - `idea-capture` — per-folder idea capture with photo + URL + forwarded-message input.
- Message input detection: text, photo, document, URL, forwarded messages.
- CPC deep-link flow for idea_dobot pairing.
- `router` / `dispatchMessage` for handler namespace dispatch within a bot.
- `better-sqlite3` state layer with migrations:
  - Pending narrator choices (length-keyboard awaiting input).
  - Rate limiting counters (per-hour job cap, daily TTS spend cap).
  - Jobs table with status tracking.
- Startup sweep: reconciles abandoned pending state on boot.
- `rebuildPendingTimeouts`: restores `setTimeout` handles for in-window pending choices that survived a restart.
- Graceful shutdown: `SIGINT` + `SIGTERM` handlers with idempotent double-signal guard.
- OTEL tracing via `@opentelemetry/sdk-trace-node` (ConsoleSpanExporter — OTLP follow-up tracked separately).
- `withSpan(tracer, name, attrs, fn)` helper for consistent span wrapping.
- `classify` prompt helper + `parsePrefix` for `[tone]` and `[tone:shape]` message prefixes.
- Tone (10) and shape (6) skill files vendored under `agents/narrator/.claude/skills/`.
- Path + URL validators with rate limits for untrusted input.
- Vitest test suite: 131 tests across router, handlers, lib, and state modules.
- systemd `--user` service (`systemd/user/dobot-server.service`) with journald logging.
- Idempotent `install.sh`: pre-flight (linger + node + env file) → build → install unit → enable + start.
- `README.md` Deploy section with install + log-tail + restart / stop commands.

### Notes

- Access control: per-bot allowlists configured via `*_ALLOWED_USER_IDS` env vars; a dedicated `gateway.json` layer is tracked separately (PR #67).
- Logs: live tail via `journalctl --user -u dobot-server -f`.
- Planned follow-ups (deferred, not in this release): OTLP exporter to local collector, `/healthz` HTTP endpoint + `sd_notify` watchdog, OTEL metrics alongside traces.

[Unreleased]: https://github.com/claudes-world/dobot-server/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/claudes-world/dobot-server/releases/tag/v0.1.0
