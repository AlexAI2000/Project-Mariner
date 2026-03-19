#!/usr/bin/env bash
# kill-stale-agents.sh — Kill only stale (zombie/idle) agent sessions.
#
# A session is STALE when:
#   - Its JSONL file has not been written to in > STALE_MINUTES (default: 15)
#   - AND the session is NOT marked as session_complete or session_end
#
# PRESERVED: openclaw server, gateway, director, director-watchdog, Chromium (openclaw browser)
# KILLED: openclaw agent workers, humanizer daemons, assistant daemons, mariner watchdogs,
#         session-daemon processes — for stale sessions ONLY.
#
# Usage: /data/mariner/kill-stale-agents.sh [--threshold-minutes N] [--dry-run]
# Returns JSON summary to stdout.

STALE_MINUTES=15
DRY_RUN=false
KILLED_PIDS=()
KILLED_SESSIONS=()

while [[ $# -gt 0 ]]; do
  case "$1" in
    --threshold-minutes) STALE_MINUTES="$2"; shift 2 ;;
    --dry-run) DRY_RUN=true; shift ;;
    *) shift ;;
  esac
done

SESSIONS_DIR="/data/sessions"
NOW=$(date +%s)
STALE_SECONDS=$(( STALE_MINUTES * 60 ))

# ── PIDs to NEVER touch ───────────────────────────────────────────────────────
# openclaw server (PID 67), gateway (PID 74), director, director-watchdog
PROTECTED_PATTERNS=(
  "openclaw-gateway"
  "director/director.js"
  "director-watchdog"
  "task-api.js"
)

is_protected() {
  local pid="$1"
  local cmdline
  cmdline=$(cat "/proc/$pid/cmdline" 2>/dev/null | tr '\0' ' ')
  for pattern in "${PROTECTED_PATTERNS[@]}"; do
    if echo "$cmdline" | grep -q "$pattern"; then
      return 0  # protected
    fi
  done
  # Also protect the main openclaw process (PID 1's children at openclaw level)
  local comm
  comm=$(cat "/proc/$pid/comm" 2>/dev/null)
  if [[ "$comm" == "openclaw" ]] && ! echo "$cmdline" | grep -q "agent --local"; then
    return 0  # protected
  fi
  return 1  # not protected
}

safe_kill() {
  local pid="$1"
  local label="$2"
  if [[ -z "$pid" ]] || ! kill -0 "$pid" 2>/dev/null; then return; fi
  if is_protected "$pid"; then
    echo "[SKIP] Protected process: $pid ($label)" >&2
    return
  fi
  if [[ "$DRY_RUN" == "true" ]]; then
    echo "[DRY-RUN] Would kill $pid ($label)" >&2
  else
    kill -TERM "$pid" 2>/dev/null
    sleep 0.3
    kill -0 "$pid" 2>/dev/null && kill -KILL "$pid" 2>/dev/null
    echo "[KILLED] $pid ($label)" >&2
  fi
  KILLED_PIDS+=("$pid")
}

# ── Phase 1: Find stale sessions via JSONL mtime ─────────────────────────────
STALE_SESSION_IDS=()

for jsonl in "$SESSIONS_DIR"/*.jsonl; do
  [[ -f "$jsonl" ]] || continue
  [[ "$jsonl" == *"-humanizer.jsonl" ]] && continue  # skip sidecar files

  MTIME=$(stat -c %Y "$jsonl" 2>/dev/null) || continue
  AGE=$(( NOW - MTIME ))
  SESSION_ID=$(basename "$jsonl" .jsonl)

  # Check if session is complete (grep -c always outputs a count; use default 0 if file unreadable)
  IS_COMPLETE=$(grep -c '"session_complete"\|"session_end"' "$jsonl" 2>/dev/null)
  IS_COMPLETE=${IS_COMPLETE:-0}

  if [[ "$AGE" -gt "$STALE_SECONDS" ]] && [[ "$IS_COMPLETE" -eq 0 ]]; then
    AGE_MIN=$(( AGE / 60 ))
    echo "[STALE] Session $SESSION_ID — last activity ${AGE_MIN}m ago, not complete" >&2
    STALE_SESSION_IDS+=("$SESSION_ID")
  elif [[ "$AGE" -gt "$STALE_SECONDS" ]] && [[ "$IS_COMPLETE" -gt 0 ]]; then
    # Session is complete but might have orphaned processes — also clean up
    echo "[COMPLETE-ORPHAN] Session $SESSION_ID — done but may have orphaned processes" >&2
    STALE_SESSION_IDS+=("$SESSION_ID")
  fi
done

if [[ ${#STALE_SESSION_IDS[@]} -eq 0 ]]; then
  echo "{\"killed_sessions\": [], \"killed_pids\": [], \"message\": \"No stale sessions found (threshold: ${STALE_MINUTES}m). System is clean.\"}"
  exit 0
fi

# ── Phase 2: Kill associated processes for each stale session ─────────────────
for SESSION_ID in "${STALE_SESSION_IDS[@]}"; do
  KILLED_SESSIONS+=("$SESSION_ID")
  echo "[KILLING] Session: $SESSION_ID" >&2

  # Kill mariner watchdogs for this session (they would restart agents otherwise)
  for wtype in pilot humanizer assistant; do
    WPID_FILE="/tmp/watchdog-${wtype}-${SESSION_ID}.pid"
    WPID=$(cat "$WPID_FILE" 2>/dev/null)
    [[ -n "$WPID" ]] && safe_kill "$WPID" "watchdog-${wtype}:${SESSION_ID}"
    # Also kill by grep in case PID file is stale
    WGREP_PID=$(pgrep -f "watchdog.sh.*${SESSION_ID}.*${wtype}" 2>/dev/null | head -1)
    [[ -n "$WGREP_PID" ]] && safe_kill "$WGREP_PID" "watchdog-grep-${wtype}:${SESSION_ID}"
  done

  # Kill humanizer daemon
  HPID_FILE="/tmp/mariner-humanizer-${SESSION_ID}.pid"
  HPID=$(cat "$HPID_FILE" 2>/dev/null)
  [[ -n "$HPID" ]] && safe_kill "$HPID" "humanizer:${SESSION_ID}"
  HGREP=$(pgrep -f "humanizer-daemon.*${SESSION_ID}" 2>/dev/null | head -1)
  [[ -n "$HGREP" ]] && safe_kill "$HGREP" "humanizer-grep:${SESSION_ID}"

  # Kill assistant daemon
  APID_FILE="/tmp/mariner-assistant-${SESSION_ID}.pid"
  APID=$(cat "$APID_FILE" 2>/dev/null)
  [[ -n "$APID" ]] && safe_kill "$APID" "assistant:${SESSION_ID}"
  AGREP=$(pgrep -f "assistant-daemon.*${SESSION_ID}" 2>/dev/null | head -1)
  [[ -n "$AGREP" ]] && safe_kill "$AGREP" "assistant-grep:${SESSION_ID}"

  # Kill pilot (openclaw agent) for this session
  PILOT_PID_FILE="/tmp/mariner-pilot-${SESSION_ID}.pid"
  PILOT_PID=$(cat "$PILOT_PID_FILE" 2>/dev/null)
  [[ -n "$PILOT_PID" ]] && safe_kill "$PILOT_PID" "pilot:${SESSION_ID}"
  # Also grep for openclaw agent processes referencing this session-id
  PGREP=$(pgrep -f "openclaw.*agent.*${SESSION_ID}\|agent.*--session-id.*${SESSION_ID}" 2>/dev/null | head -1)
  [[ -n "$PGREP" ]] && safe_kill "$PGREP" "pilot-grep:${SESSION_ID}"

  # Kill session-daemon for this session
  SDGREP=$(pgrep -f "session-daemon.*${SESSION_ID}" 2>/dev/null | head -1)
  [[ -n "$SDGREP" ]] && safe_kill "$SDGREP" "session-daemon:${SESSION_ID}"

  # Mark session as terminated in JSONL
  if [[ "$DRY_RUN" != "true" ]]; then
    echo "{\"ts\":$(date +%s%3N),\"type\":\"session_end\",\"status\":\"terminated\",\"reason\":\"stale-killed-by-operator\",\"killedAt\":\"$(date -Iseconds)\"}" \
      >> "${SESSIONS_DIR}/${SESSION_ID}.jsonl" 2>/dev/null
  fi
done

# ── Phase 3: Kill any openclaw agents whose session ID has no active JSONL ───
# These are truly orphaned agent processes not tied to any known session
while IFS= read -r pid; do
  [[ -z "$pid" ]] && continue
  CMDLINE=$(cat "/proc/$pid/cmdline" 2>/dev/null | tr '\0' ' ')
  # Extract session-id from command line
  SESSION_ID=$(echo "$CMDLINE" | grep -oP '(?<=--session-id )[^\s]+' | head -1)
  if [[ -z "$SESSION_ID" ]]; then
    # Old-style agent without session-id — check if it's been running > threshold
    START=$(stat -c %Y "/proc/$pid" 2>/dev/null || echo "$NOW")
    AGE=$(( NOW - START ))
    if [[ "$AGE" -gt "$STALE_SECONDS" ]]; then
      safe_kill "$pid" "orphaned-agent-no-session"
    fi
  fi
done < <(pgrep -f "openclaw agent --local" 2>/dev/null)

# ── Summary ───────────────────────────────────────────────────────────────────
UNIQUE_PIDS=$(printf '%s\n' "${KILLED_PIDS[@]}" | sort -u | tr '\n' ',' | sed 's/,$//')
UNIQUE_SESSIONS=$(printf '"%s",' "${KILLED_SESSIONS[@]}" | sed 's/,$//')

echo "{
  \"killed_sessions\": [${UNIQUE_SESSIONS}],
  \"killed_pid_count\": ${#KILLED_PIDS[@]},
  \"dry_run\": ${DRY_RUN},
  \"threshold_minutes\": ${STALE_MINUTES},
  \"message\": \"Killed ${#KILLED_SESSIONS[@]} stale session(s) and ${#KILLED_PIDS[@]} associated process(es).\"
}"
