#!/usr/bin/env bash
# github-sync-code.sh — Sync VPS code to GitHub (vps-code branch).
# ADD-ONLY: never propagates deletions. If files are deleted on VPS,
# they stay safe on GitHub until explicitly removed.
#
# Repo: https://github.com/AlexAI2000/Project-Mariner (vps-code branch)

set -euo pipefail

GIT_WORK=/docker/openclaw-mrdz/data
LOG_FILE=/tmp/github-sync-code.log
TIMESTAMP=$(date '+%Y-%m-%d %H:%M:%S')

export GIT_DIR="${GIT_WORK}/.git"
export GIT_WORK_TREE="${GIT_WORK}"
export GIT_AUTHOR_NAME="Project Mariner Head of Ops"
export GIT_AUTHOR_EMAIL="ops@projectmariner.ai"
export GIT_COMMITTER_NAME="Project Mariner Head of Ops"
export GIT_COMMITTER_EMAIL="ops@projectmariner.ai"

log() { echo "[${TIMESTAMP}] $*" | tee -a "$LOG_FILE"; }

log "=== Code sync starting ==="

# Stage new and modified files only
git add -A

# UN-STAGE any deletions — add-only policy, never remove from GitHub
DELETED=$(git diff --cached --name-only --diff-filter=D 2>/dev/null || true)
if [ -n "$DELETED" ]; then
  log "Skipping deletions (add-only policy): $(echo "$DELETED" | tr '\n' ' ')"
  git restore --staged $DELETED 2>/dev/null || true
fi

if git diff --cached --quiet; then
  log "No changes — nothing to commit."
  exit 0
fi

CHANGED=$(git diff --cached --name-only | wc -l)
log "Committing ${CHANGED} file(s)..."
git commit -m "Auto-sync code: ${TIMESTAMP} (${CHANGED} files)"

log "Pushing to GitHub (vps-code)..."
git push origin vps-code

log "=== Sync complete ==="
