#!/usr/bin/env node
// submit-command.js — Pilot's command bus interface.
//
// Usage: node /data/mariner/submit-command.js <sessionId> "<cmd>" [timeoutSeconds]
//
// 1. Writes a pending_command event to the session JSONL.
// 2. Waits for a matching command_executed event from the Humanizer.
// 3. Waits for the ready_for_next signal from the Assistant.
// 4. Prints the command output to stdout (so the Pilot can read it).
//
// Exit 0 = success, Exit 1 = timeout/error, Exit 2 = session complete (stop looping)

import { appendFileSync, readFileSync, existsSync } from 'fs';
import { randomUUID } from 'crypto';
import { join } from 'path';

const SESSIONS_DIR = '/data/sessions';

const [, , sessionId, cmd, timeoutArg] = process.argv;
if (!sessionId || !cmd) {
  console.error('Usage: node submit-command.js <sessionId> "<cmd>" [timeoutSeconds]');
  process.exit(1);
}

const TIMEOUT_MS = (parseInt(timeoutArg, 10) || 300) * 1000;
const POLL_MS = 300;

function sessionPath() {
  return join(SESSIONS_DIR, `${sessionId}.jsonl`);
}

function appendLine(obj) {
  const line = JSON.stringify({ ts: Date.now(), ...obj }) + '\n';
  appendFileSync(sessionPath(), line, 'utf8');
}

function readLines() {
  if (!existsSync(sessionPath())) return [];
  try {
    return readFileSync(sessionPath(), 'utf8').trim().split('\n').filter(Boolean);
  } catch { return []; }
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// ── Check if session already complete before doing anything ───────────────────
function isComplete(lines) {
  return lines.some(l => {
    try { return JSON.parse(l).type === 'session_complete'; } catch { return false; }
  });
}

// ── Main ───────────────────────────────────────────────────────────────────────

const cmdId = randomUUID();
const submittedAt = Date.now();

// Bail early if session already complete
if (isComplete(readLines())) {
  console.log('[submit-command] Session already complete — nothing to do.');
  process.exit(2);
}

// Write pending_command
appendLine({ type: 'pending_command', agentId: 'pilot', cmd, cmdId });
// console.error(`[submit-command] Submitted cmdId=${cmdId}`);

const deadline = Date.now() + TIMEOUT_MS;

async function waitForExecution() {
  while (Date.now() < deadline) {
    const lines = readLines();

    if (isComplete(lines)) {
      console.log('[submit-command] Session marked complete.');
      process.exit(2);
    }

    // Find matching command_executed
    let executed = null;
    let readyForNext = false;

    for (const line of lines) {
      try {
        const obj = JSON.parse(line);
        if (obj.type === 'command_executed' && obj.cmdId === cmdId) {
          executed = obj;
        }
        // Look for ready_for_next AFTER the execution
        if (executed && obj.type === 'signal' && obj.status === 'ready_for_next' && obj.ts >= submittedAt) {
          readyForNext = true;
        }
      } catch { /* skip bad lines */ }
    }

    if (executed && readyForNext) {
      // Print the command output so the Pilot can read it
      if (executed.status === 'error' || executed.error) {
        process.stderr.write(`[COMMAND ERROR] ${executed.error || 'unknown error'}\n`);
      }
      if (executed.output !== undefined && executed.output !== null) {
        process.stdout.write(String(executed.output));
      }
      process.exit(0);
    }

    await sleep(POLL_MS);
  }

  process.stderr.write(`[submit-command] TIMEOUT: cmdId=${cmdId} waited ${TIMEOUT_MS / 1000}s with no response.\n`);
  process.exit(1);
}

waitForExecution().catch(err => {
  process.stderr.write(`[submit-command] Fatal: ${err.message}\n`);
  process.exit(1);
});
