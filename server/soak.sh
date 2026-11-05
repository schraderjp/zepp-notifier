#!/bin/sh
# Soak test: queue one notification every N seconds so the trace has push traffic,
# not just pings. Pongs prove the listener is alive; only pushes prove delivery
# (and give a latency distribution under doze).
#
#   server/soak.sh [interval_s=1800] [cycles=16] [port=8097] [vibrate=5]
#
# vibrate=0 renders notifications silently: delivery, latency and the action
# path are all still exercised, but nothing buzzes on the wrist.
#
# Each notification is labelled with its local time and cycle number, and carries
# two buttons so tap reliability can be counted from the trace.
set -eu

INTERVAL=${1:-1800}
CYCLES=${2:-16}
PORT=${3:-8097}
VIBRATE=${4:-5}
i=0

while [ "$i" -lt "$CYCLES" ]; do
  i=$((i + 1))
  label=$(date +%H:%M)
  body=$(printf 'Cycle %d of %d. Tap yes or no.' "$i" "$CYCLES")
  payload=$(printf '{"title":"Soak %s","body":"%s","actions":["Yes","No"],"vibrate":%s}' "$label" "$body" "$VIBRATE")

  response=$(curl -s -m 10 -X POST "http://localhost:$PORT/v1/notify" \
    -H 'Content-Type: application/json' -d "$payload" || echo "curl failed")

  echo "$(date +%H:%M:%S) cycle $i/$CYCLES -> $response"

  [ "$i" -lt "$CYCLES" ] && sleep "$INTERVAL"
done

echo "$(date +%H:%M:%S) soak finished ($CYCLES cycles)"
