#!/usr/bin/env bash
# Keeper supervisor: restarts the keeper if it exits. Start with:
#   nohup ./run.sh >> keeper.log 2>&1 &  echo $! > keeper.pid
# Stop with: kill $(cat keeper.pid)   (the trap also stops the child)
cd "$(dirname "$0")"
child=
trap '[ -n "$child" ] && kill "$child" 2>/dev/null; exit 0' TERM INT
while true; do
  # Self-heal: a box reset can wipe node_modules; reinstall from the lockfile.
  [ -x ./node_modules/.bin/tsx ] || { echo "$(date -Is) run.sh: node_modules missing, running npm ci"; npm ci --no-audit --no-fund || true; }
  echo "$(date -Is) run.sh: starting keeper"
  ./node_modules/.bin/tsx src/index.ts &
  child=$!
  wait "$child"
  echo "$(date -Is) run.sh: keeper exited with $?, restarting in 5s"
  sleep 5
done
