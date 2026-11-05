#!/bin/sh
# Small supervisor for the spike relay, so a long test run does not depend on a
# terminal staying open and so stopping it never risks killing the wrong process
# (pkill -f patterns match the calling shell too).
#
#   server/relay.sh start [port]     default port 8097
#   server/relay.sh stop
#   server/relay.sh status
#   server/relay.sh logs             follow the event trace
set -eu

DIR=$(cd "$(dirname "$0")" && pwd)
PIDFILE="$DIR/log/relay.pid"
OUT="$DIR/log/relay.out"
STATE="$DIR/log/state.json"
PORT=${2:-8097}

mkdir -p "$DIR/log"

running() {
  [ -f "$PIDFILE" ] || return 1
  pid=$(cat "$PIDFILE")
  [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null
}

case "${1:-status}" in
  start)
    if running; then
      echo "already running (pid $(cat "$PIDFILE"))"
      exit 0
    fi
    nohup python3 "$DIR/spike_server.py" --host 0.0.0.0 --port "$PORT" \
      --state "$STATE" >>"$OUT" 2>&1 &
    echo $! >"$PIDFILE"
    sleep 1
    if running; then
      echo "started pid $(cat "$PIDFILE") on port $PORT (log: $OUT)"
    else
      echo "failed to start, see $OUT"
      rm -f "$PIDFILE"
      exit 1
    fi
    ;;
  stop)
    if running; then
      pid=$(cat "$PIDFILE")
      kill "$pid" 2>/dev/null || true
      sleep 0.5
      kill -0 "$pid" 2>/dev/null && kill -9 "$pid" 2>/dev/null || true
      echo "stopped pid $pid"
    else
      echo "not running"
    fi
    rm -f "$PIDFILE"
    ;;
  status)
    if running; then
      echo "running (pid $(cat "$PIDFILE"))"
      curl -s --max-time 3 "http://localhost:$PORT/health" || echo "  (health check failed)"
      echo
    else
      echo "not running"
      exit 1
    fi
    ;;
  logs)
    tail -f "$DIR/log/events.jsonl" | jq -r '
      [(.received_at/1000|strflocaltime("%H:%M:%S")), .event, (del(.received_at,.event)|tojson)] | @tsv'
    ;;
  *)
    echo "usage: $0 {start [port]|stop|status|logs}" >&2
    exit 2
    ;;
esac
