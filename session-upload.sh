#!/usr/bin/env bash
# session-upload.sh — Upload completed session files to Google Drive
#
# Usage:
#   bash /data/session-upload.sh <sessionId> [pilotAgentName]
#
# Uploads:
#   Apex Pilot session JSONL  → gdrive:slicer-apex-sessions/
#   Sidecar session JSONL     → gdrive:slicer-sidecar-sessions/
#
# Google Drive folder IDs (configured in rclone remotes):
#   Apex:    1kM9es9bLp19SBy_w21KGSrbcEX0m_7yH
#   Sidecar: 1F9VHu2TGASxboARITeBt8jQehfyiGP0r

SESSION_ID="${1:-}"
PILOT_AGENT="${2:-}"
LOG_FILE=/tmp/session-upload.log
TIMESTAMP=$(date '+%Y-%m-%d %H:%M:%S')

RCLONE_APEX_REMOTE="gdrive-apex"
RCLONE_SIDECAR_REMOTE="gdrive-sidecar"

SIDECAR_DIR="/docker/openclaw-mrdz/data/sessions"
PILOT_SESSIONS_BASE="/docker/openclaw-mrdz/data/.openclaw/agents"

log() {
  echo "[${TIMESTAMP}] $*" | tee -a "$LOG_FILE"
}

if [[ -z "$SESSION_ID" ]]; then
  log "ERROR: No sessionId provided."
  echo "Usage: bash /data/session-upload.sh <sessionId> [pilotAgentName]"
  exit 1
fi

log "=== Session upload starting: ${SESSION_ID} ==="

# ── 1. Upload sidecar JSONL (main session trace) ─────────────────────────────
SIDECAR_FILE="${SIDECAR_DIR}/${SESSION_ID}.jsonl"
if [[ -f "$SIDECAR_FILE" ]]; then
  log "Uploading sidecar: ${SIDECAR_FILE}"
  if rclone copy "$SIDECAR_FILE" "${RCLONE_SIDECAR_REMOTE}:" --log-file="$LOG_FILE" 2>&1; then
    log "Sidecar upload OK"
  else
    log "WARNING: Sidecar upload failed (non-fatal)"
  fi
else
  log "No sidecar file found at ${SIDECAR_FILE} — skipping"
fi

# ── 2. Upload Apex Pilot session JSONL ────────────────────────────────────────
# Try the provided pilot agent name first, then search all workers
PILOT_FILE=""

if [[ -n "$PILOT_AGENT" ]]; then
  CANDIDATE="${PILOT_SESSIONS_BASE}/${PILOT_AGENT}/sessions/${SESSION_ID}.jsonl"
  if [[ -f "$CANDIDATE" ]]; then
    PILOT_FILE="$CANDIDATE"
  fi
fi

# Fallback: search all worker-* agents for this session
if [[ -z "$PILOT_FILE" ]]; then
  for f in "${PILOT_SESSIONS_BASE}"/worker-*/sessions/"${SESSION_ID}".jsonl; do
    if [[ -f "$f" ]]; then
      PILOT_FILE="$f"
      break
    fi
  done
fi

# Also check main agent
if [[ -z "$PILOT_FILE" && -f "${PILOT_SESSIONS_BASE}/main/sessions/${SESSION_ID}.jsonl" ]]; then
  PILOT_FILE="${PILOT_SESSIONS_BASE}/main/sessions/${SESSION_ID}.jsonl"
fi

if [[ -n "$PILOT_FILE" ]]; then
  log "Uploading apex pilot session: ${PILOT_FILE}"
  if rclone copy "$PILOT_FILE" "${RCLONE_APEX_REMOTE}:" --log-file="$LOG_FILE" 2>&1; then
    log "Apex pilot upload OK"
  else
    log "WARNING: Apex pilot upload failed (non-fatal)"
  fi
else
  log "No apex pilot JSONL found for session ${SESSION_ID} — skipping"
fi

log "=== Session upload complete: ${SESSION_ID} ==="
