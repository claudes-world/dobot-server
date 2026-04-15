#!/usr/bin/env bash
echo "{\"name\":\"session.narrator.stop\",\"ts\":$(date +%s%3N),\"job_id\":\"${NARRATOR_JOB_ID:-unknown}\"}" >> /tmp/otel-narrator.jsonl 2>/dev/null || true
exit 0
