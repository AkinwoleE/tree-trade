#!/usr/bin/env bash
# Hedger supervisor: restarts the hedger if it exits. Separate from the keeper (run.sh). Start with:
#   nohup setsid ./run-hedger.sh >> hedger.log 2>&1 < /dev/null &  echo $! > hedger.pid
# Stop with: kill $(cat hedger.pid)   (the trap also stops the child)
cd "$(dirname "$0")"
child=
trap '[ -n "$child" ] && kill "$child" 2>/dev/null; wait "$child" 2>/dev/null; exit 0' TERM INT
while true; do
  # Self-heal: a box reset can wipe node_modules; reinstall from the lockfile.
  [ -x ./node_modules/.bin/tsx ] || { echo "$(date -Is) run-hedger.sh: node_modules missing, running npm ci"; npm ci --no-audit --no-fund || true; }
  echo "$(date -Is) run-hedger.sh: starting hedger"
  ./node_modules/.bin/tsx src/hedge/hedger.ts "$@" &
  child=$!
  wait "$child"
  echo "$(date -Is) run-hedger.sh: hedger exited with $?, restarting in 10s"
  sleep 10
done
