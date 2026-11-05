#!/bin/sh
# Seed /data/state.json on first start so deploying is zero-touch: clone, set the
# secret, up. A named volume persists afterwards, so this only ever runs once per
# volume and can never clobber a real queue. To carry over an existing queue
# instead, copy your state.json into the volume before the first start (see
# docs/hosting.md) — a present, non-empty file is left alone.
set -eu
mkdir -p /data
if [ ! -s /data/state.json ]; then
  cp /srv/relay/seed-state.json /data/state.json
  echo "relay: seeded empty state into /data/state.json"
fi
exec python3 -u spike_server.py "$@"
