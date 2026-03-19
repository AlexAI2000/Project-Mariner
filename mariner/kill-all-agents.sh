#!/usr/bin/env bash
# kill-all-agents.sh — Nuclear option: kill ALL agent sessions and worker processes.
#
# PRESERVED (never touched):
#   - openclaw server (main process, not "agent --local")
#   - openclaw-gateway
#   - director/director.js
#   - director-watchdog
#   - task-api.js
#   - Chromium/Mimic browser processes (MLX profiles)
#
# KILLED:
#   - All mariner watchdog processes
#   - All humanizer daemon processes
#   - All assistant daemon processes
#   - All openclaw agent --local worker processes
#   - All session-daemon processes
#   - All PID files cleaned up from /tmp/
#
# Marks ALL incomplete sessions as terminated in their JSONL files.
#
# Usage: /data/mariner/kill-all-agents.sh [--dry-run]
# Returns JSON summary to stdout.

DRY_RUN=false
KILLED_PIDS=()
KILLED_SESSIONS=()

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run) DRY_RUN=true; shift ;;
    *) shift ;;
  esac
done

SESSIONS_DIR="/data/sessions"
NOW=$(date +%s)

# ── PIDs to NEVER touch ───────────────────────────────────────────────────────
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
  # Protect the main openclaw server process (not worker agents)
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

# ── Phase 1: Kill ALL watchdogs first (prevents them from restarting agents) ──
echo "[kill-all] Phase 1: Killing all watchdogs..." >&2

for wtype in pilot humanizer assistant; do
  while IFS= read -r pid; do
    [[ -z "$pid" ]] && continue
    safe_kill "$pid" "watchdog-${wtype}"
  done < <(pgrep -f "watchdog.sh.*${wtype}" 2>/dev/null)
done

# Also kill any watchdog PID files
for wpid_file in /tmp/watchdog-*.pid; do
  [[ -f "$wpid_file" ]] || continue
  WPID=$(cat "$wpid_file" 2>/dev/null)
  [[ -n "$WPID" ]] && safe_kill "$WPID" "watchdog-pidfile:$(basename $wpid_file)"
  [[ "$DRY_RUN" != "true" ]] && rm -f "$wpid_file"
done

# ── Phase 2: Kill ALL humanizer daemons ──────────────────────────────────────
echo "[kill-all] Phase 2: Killing all humanizer daemons..." >&2

while IFS= read -r pid; do
  [[ -z "$pid" ]] && continue
  safe_kill "$pid" "humanizer-daemon"
done < <(pgrep -f "humanizer-daemon" 2>/dev/null)

for hpid_file in /tmp/mariner-humanizer-*.pid; do
  [[ -f "$hpid_file" ]] || continue
  HPID=$(cat "$hpid_file" 2>/dev/null)
  [[ -n "$HPID" ]] && safe_kill "$HPID" "humanizer-pidfile:$(basename $hpid_file)"
  [[ "$DRY_RUN" != "true" ]] && rm -f "$hpid_file"
done

# ── Phase 3: Kill ALL assistant daemons ──────────────────────────────────────
echo "[kill-all] Phase 3: Killing all assistant daemons..." >&2

while IFS= read -r pid; do
  [[ -z "$pid" ]] && continue
  safe_kill "$pid" "assistant-daemon"
done < <(pgrep -f "assistant-daemon" 2>/dev/null)

for apid_file in /tmp/mariner-assistant-*.pid; do
  [[ -f "$apid_file" ]] || continue
  APID=$(cat "$apid_file" 2>/dev/null)
  [[ -n "$APID" ]] && safe_kill "$APID" "assistant-pidfile:$(basename $apid_file)"
  [[ "$DRY_RUN" != "true" ]] && rm -f "$apid_file"
done

# ── Phase 4: Kill ALL openclaw agent --local worker processes ─────────────────
echo "[kill-all] Phase 4: Killing all openclaw agent workers..." >&2

while IFS= read -r pid; do
  [[ -z "$pid" ]] && continue
  safe_kill "$pid" "openclaw-agent-worker"
done < <(pgrep -f "openclaw agent --local" 2>/dev/null)

for ppid_file in /tmp/mariner-pilot-*.pid; do
  [[ -f "$ppid_file" ]] || continue
  PPID=$(cat "$ppid_file" 2>/dev/null)
  [[ -n "$PPID" ]] && safe_kill "$PPID" "pilot-pidfile:$(basename $ppid_file)"
  [[ "$DRY_RUN" != "true" ]] && rm -f "$ppid_file"
done

# ── Phase 5: Kill ALL session-daemon processes ────────────────────────────────
echo "[kill-all] Phase 5: Killing all session-daemons..." >&2

while IFS= read -r pid; do
  [[ -z "$pid" ]] && continue
  safe_kill "$pid" "session-daemon"
done < <(pgrep -f "session-daemon" 2>/dev/null)

# ── Phase 6: Mark all incomplete sessions as terminated ───────────────────────
echo "[kill-all] Phase 6: Marking all incomplete sessions as terminated..." >&2

for jsonl in "$SESSIONS_DIR"/*.jsonl; do
  [[ -f "$jsonl" ]] || continue
  [[ "$jsonl" == *"-humanizer.jsonl" ]] && continue

  SESSION_ID=$(basename "$jsonl" .jsonl)
  IS_COMPLETE=$(grep -c '"session_complete"\|"session_end"' "$jsonl" 2>/dev/null)
  IS_COMPLETE=${IS_COMPLETE:-0}

  if [[ "$IS_COMPLETE" -eq 0 ]]; then
    KILLED_SESSIONS+=("$SESSION_ID")
    echo "[TERMINATED] Session: $SESSION_ID" >&2
    if [[ "$DRY_RUN" != "true" ]]; then
      echo "{\"ts\":$(date +%s%3N),\"type\":\"session_end\",\"status\":\"terminated\",\"reason\":\"kill-all-by-operator\",\"killedAt\":\"$(date -Iseconds)\"}" \
        >> "${SESSIONS_DIR}/${SESSION_ID}.jsonl" 2>/dev/null
    fi
  fi
done

# ── Phase 7: Clean up stale counter files ────────────────────────────────────
if [[ "$DRY_RUN" != "true" ]]; then
  rm -f /tmp/mariner-counter-*.json
  echo "[kill-all] Cleaned up stale counter files." >&2
fi

# ── Summary ───────────────────────────────────────────────────────────────────
UNIQUE_PIDS=$(printf '%s\n' "${KILLED_PIDS[@]}" | sort -u | tr '\n' ',' | sed 's/,$//')
UNIQUE_SESSIONS=$(printf '"%s",' "${KILLED_SESSIONS[@]}" | sed 's/,$//')

echo "{
  \"killed_sessions\": [${UNIQUE_SESSIONS}],
  \"killed_pid_count\": ${#KILLED_PIDS[@]},
  \"dry_run\": ${DRY_RUN},
  \"message\": \"Nuclear kill complete. Killed ${#KILLED_SESSIONS[@]} session(s) and ${#KILLED_PIDS[@]} process(es). Core infrastructure preserved.\"
}"
