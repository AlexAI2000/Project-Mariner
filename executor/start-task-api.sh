#!/bin/bash
# start-task-api.sh — Start the task API server (or restart if already running).
# Usage: bash /data/executor/start-task-api.sh
# The server runs on port 18790. Logs go to /tmp/task-api.log.

PID_FILE=/tmp/task-api.pid
LOG_FILE=/tmp/task-api.log

# Kill existing process if running
if [ -f "$PID_FILE" ]; then
  OLD_PID=$(cat "$PID_FILE")
  if kill -0 "$OLD_PID" 2>/dev/null; then
    kill "$OLD_PID"
    sleep 1
  fi
  rm -f "$PID_FILE"
fi

# Start server in background
node /data/executor/task-api.js >> "$LOG_FILE" 2>&1 &
PID=$!
echo $PID > "$PID_FILE"
echo "task-api started (PID=$PID) on port ${TASK_API_PORT:-18790}. Logs: $LOG_FILE"
