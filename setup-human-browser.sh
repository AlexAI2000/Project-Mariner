#!/bin/bash
# Sets up the HumanBrowser system with MultiLogin X:
# installs deps, starts Xvfb + mlx agent, creates dirs, starts director daemon

set -e
BASE=/data

echo "=== HumanBrowser + MultiLogin X Setup ==="

# Install playwright-core
cd $BASE/human-browser
echo "Installing playwright-core..."
npm install --quiet

# Create task queue dirs
mkdir -p $BASE/task-queue/pending
mkdir -p $BASE/task-queue/running
mkdir -p $BASE/task-queue/done

# Create session store dir
mkdir -p $BASE/sessions

# Create MultiLogin registry dir
mkdir -p $BASE/multilogin
[ -f $BASE/multilogin/open-profiles.json ] || echo '{}' > $BASE/multilogin/open-profiles.json

# Create clients dir
mkdir -p $BASE/clients

echo "Directories created."

# ── MultiLogin X connectivity check ──────────────────────────────────────────
# mlx agent runs in the visual-vps container (not here).
# This container reaches it via https://launcher.mlx.yt:45001
# (launcher.mlx.yt is mapped to 172.18.0.3 via /etc/hosts + docker-compose extra_hosts)

echo "Checking MultiLogin X launcher connectivity..."
for i in 1 2 3; do
  RESULT=$(curl -sf https://launcher.mlx.yt:45001/api/v1/version 2>/dev/null)
  if [ -n "$RESULT" ]; then
    echo "MultiLogin X launcher reachable: $RESULT"
    break
  fi
  echo "  Launcher not responding yet... attempt $i/3"
  sleep 3
done

# ── Director daemon ───────────────────────────────────────────────────────────

pkill -f "director/director.js" 2>/dev/null || true
sleep 1

echo "Starting director daemon..."
nohup node $BASE/director/director.js >> /tmp/director.log 2>&1 &
DIRECTOR_PID=$!
echo "Director started (PID $DIRECTOR_PID)"
echo $DIRECTOR_PID > /tmp/director.pid

sleep 2

if kill -0 $DIRECTOR_PID 2>/dev/null; then
  echo "=== Director is running ==="
else
  echo "ERROR: Director failed to start. Check /tmp/director.log"
  cat /tmp/director.log
  exit 1
fi

# ── Task API server ───────────────────────────────────────────────────────────

pkill -f "executor/task-api.js" 2>/dev/null || true
sleep 1

echo "Starting task-api server (port 18790)..."
nohup node $BASE/executor/task-api.js >> /tmp/task-api.log 2>&1 &
TASKAPI_PID=$!
echo "task-api started (PID $TASKAPI_PID)"
echo $TASKAPI_PID > /tmp/task-api.pid

sleep 1

if kill -0 $TASKAPI_PID 2>/dev/null; then
  echo "=== task-api is running ==="
else
  echo "WARNING: task-api may have failed to start. Check /tmp/task-api.log"
fi

echo ""
echo "=== Setup complete ==="
echo "MultiLogin X launcher: https://launcher.mlx.yt:45001 (→ visual-vps:45001)"
echo "Director log:          /tmp/director.log"
echo "Task queue:            /data/task-queue/"
echo ""
echo "To dispatch a browser task:"
echo "  node /data/director/dispatch.js '{\"clientId\":\"john-doe\",\"platform\":\"linkedin\",\"steps\":[{\"action\":\"goto\",\"url\":\"https://example.com\"}]}'"
