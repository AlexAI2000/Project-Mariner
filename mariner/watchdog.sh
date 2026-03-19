#!/usr/bin/env bash
# watchdog.sh — Mariner Apex Watchdog (infinite loop daemon, 10s audit cycle)
#
# Monitors one agent process. If the process dies and the session is not yet
# complete, it restarts the process within 10 seconds.
#
# Usage:
#   /data/mariner/watchdog.sh <sessionId> <agentType> <pidFile> <restartCmd...>
#
# Arguments:
#   sessionId   — Session ID to monitor (for JSONL completion check)
#   agentType   — Label: "pilot" | "humanizer" | "assistant"
#   pidFile     — Path to the PID file written by the agent on startup
#   restartCmd  — Full command to restart the agent (rest of argv)
#
# The watchdog writes its own PID to /tmp/watchdog-<agentType>-<sessionId>.pid

SESSION_ID="$1"
AGENT_TYPE="$2"
PID_FILE="$3"
shift 3
RESTART_CMD=("$@")

if [[ -z "$SESSION_ID" || -z "$AGENT_TYPE" || -z "$PID_FILE" || ${#RESTART_CMD[@]} -eq 0 ]]; then
  echo "[watchdog] Usage: watchdog.sh <sessionId> <agentType> <pidFile> <restartCmd...>" >&2
  exit 1
fi

JSONL_FILE="/data/sessions/${SESSION_ID}.jsonl"
MY_PID_FILE="/tmp/watchdog-${AGENT_TYPE}-${SESSION_ID}.pid"
SLEEP_INTERVAL=10

echo $$ > "$MY_PID_FILE"
echo "[watchdog:${AGENT_TYPE}] Started — session=${SESSION_ID} pid=$$" >&2

# ── Helper: is session complete? ─────────────────────────────────────────────
session_complete() {
  [[ -f "$JSONL_FILE" ]] && grep -q '"session_complete"' "$JSONL_FILE" 2>/dev/null
}

# ── Helper: is agent process alive? ─────────────────────────────────────────
agent_alive() {
  local pid
  pid=$(cat "$PID_FILE" 2>/dev/null)
  [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null
}

# ── Main Loop ────────────────────────────────────────────────────────────────
while true; do
  sleep "$SLEEP_INTERVAL"

  # If session is done, watchdog's job is finished.
  if session_complete; then
    echo "[watchdog:${AGENT_TYPE}] Session ${SESSION_ID} complete — exiting." >&2
    # ── Session upload trigger (pilot watchdog only, to avoid triple-upload) ──
    if [[ "$AGENT_TYPE" == "pilot" ]]; then
      echo "[watchdog:${AGENT_TYPE}] Triggering session upload for ${SESSION_ID}..." >&2
      bash /data/session-upload.sh "${SESSION_ID}" >> /tmp/session-upload-${SESSION_ID}.log 2>&1 &
    fi
    exit 0
  fi

  # If agent is alive, nothing to do.
  if agent_alive; then
    continue
  fi

  # Agent is dead and session is not complete — restart it.
  echo "[watchdog:${AGENT_TYPE}] Agent dead (session not complete) — restarting..." >&2

  # Run restart command in background, capture PID
  "${RESTART_CMD[@]}" &
  NEW_PID=$!

  # Give the agent 2s to write its own PID file; fallback to our captured PID
  sleep 2
  if [[ ! -f "$PID_FILE" ]] || ! kill -0 "$(cat "$PID_FILE" 2>/dev/null)" 2>/dev/null; then
    echo "$NEW_PID" > "$PID_FILE"
  fi

  echo "[watchdog:${AGENT_TYPE}] Restarted — new pid=$(cat "$PID_FILE" 2>/dev/null)" >&2
done
