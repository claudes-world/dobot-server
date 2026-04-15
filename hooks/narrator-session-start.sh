#!/usr/bin/env bash
command -v jq &>/dev/null || exit 0
jq -n --arg id "${NARRATOR_JOB_ID:-unknown}" \
   --argjson ts "$(date +%s%3N)" \
   '{name: "session.narrator.start", ts: $ts, job_id: $id}' \
   >> /tmp/otel-narrator.jsonl 2>/dev/null || true
exit 0
