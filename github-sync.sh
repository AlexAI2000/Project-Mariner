#!/usr/bin/env bash
# github-sync.sh — Auto-sync Project Mariner .openclaw workspace to GitHub
# Runs every 30 minutes via cron. Commits any new/changed/deleted files.
#
# Repo:    https://github.com/AlexAI2000/slicer (main branch)
# WorkDir: /docker/openclaw-mrdz/data/.openclaw

set -euo pipefail

GIT_WORK=/docker/openclaw-mrdz/data/.openclaw
LOG_FILE=/tmp/github-sync.log
TIMESTAMP=$(date '+%Y-%m-%d %H:%M:%S')

export GIT_DIR="${GIT_WORK}/.git"
export GIT_WORK_TREE="${GIT_WORK}"
export GIT_AUTHOR_NAME="Project Mariner Head of Ops"
export GIT_AUTHOR_EMAIL="ops@projectmariner.ai"
export GIT_COMMITTER_NAME="Project Mariner Head of Ops"
export GIT_COMMITTER_EMAIL="ops@projectmariner.ai"

log() {
  echo "[${TIMESTAMP}] $*" | tee -a "$LOG_FILE"
}

log "=== GitHub sync starting ==="

# Stage all changes
git add -A

# Check if there's anything to commit
if git diff --cached --quiet; then
  log "No changes — nothing to commit."
  exit 0
fi

# Count changed files
CHANGED=$(git diff --cached --name-only | wc -l)
log "Committing ${CHANGED} changed file(s)..."

git commit -m "Auto-sync: ${TIMESTAMP} (${CHANGED} files changed)"

# Push
log "Pushing to GitHub..."
git push origin main

log "=== Sync complete ==="
