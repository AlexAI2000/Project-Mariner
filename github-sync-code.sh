#!/usr/bin/env bash
# github-sync-code.sh — Auto-sync VPS code files to GitHub (vps-code branch)
# Runs every 30 minutes via cron alongside github-sync.sh.
#
# Repo:    https://github.com/AlexAI2000/Project-Mariner (vps-code branch)
# WorkDir: /docker/openclaw-mrdz/data

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

log() {
  echo "[${TIMESTAMP}] $*" | tee -a "$LOG_FILE"
}

log "=== Code sync starting ==="

git add -A

if git diff --cached --quiet; then
  log "No changes — nothing to commit."
  exit 0
fi

CHANGED=$(git diff --cached --name-only | wc -l)
log "Committing ${CHANGED} changed file(s)..."

git commit -m "Auto-sync code: ${TIMESTAMP} (${CHANGED} files changed)"

log "Pushing to GitHub (vps-code)..."
git push origin vps-code

log "=== Code sync complete ==="
