#!/usr/bin/env node
// assistant-daemon.js — Mariner Assistant
//
// Monitors the session JSONL for command_executed events from the Humanizer.
// When a command_executed appears with no subsequent ready_for_next signal
// for the same cmdId, writes the ready_for_next signal to unblock the Pilot.
//
// Also monitors overall session health and marks task progress in the JSONL.
//
// Usage: node /data/mariner/assistant-daemon.js <sessionId> <agentId> <pidFile>
// Exit 0 = session complete naturally, Exit 1 = fatal error

import { appendFileSync, readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';

const SESSIONS_DIR = '/data/sessions';
const POLL_MS = 200; // Fast poll — this is the critical signal path

const [, , sessionId, agentId = 'mariner-assistant', pidFile] = process.argv;
if (!sessionId) {
  console.error('Usage: node assistant-daemon.js <sessionId> <agentId> <pidFile>');
  process.exit(1);
}

// Write PID
if (pidFile) {
  mkdirSync('/tmp', { recursive: true });
  writeFileSync(pidFile, String(process.pid), 'utf8');
}

function sessionPath() { return join(SESSIONS_DIR, `${sessionId}.jsonl`); }

function appendToSession(obj) {
  const line = JSON.stringify({ ts: Date.now(), ...obj }) + '\n';
  appendFileSync(sessionPath(), line, 'utf8');
}

function readLines() {
  if (!existsSync(sessionPath())) return [];
  try { return readFileSync(sessionPath(), 'utf8').trim().split('\n').filter(Boolean); }
  catch { return []; }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── Main Loop ─────────────────────────────────────────────────────────────────

console.error(`[assistant-daemon] Started — session=${sessionId} agent=${agentId} pid=${process.pid}`);

// Track which cmdIds we've already signaled ready_for_next for (crash recovery).
const signaledCmdIds = new Set();

// On startup, pre-populate from existing JSONL so we don't double-signal.
function loadExistingSignals() {
  const lines = readLines();
  for (const line of lines) {
    try {
      const obj = JSON.parse(line);
      if (obj.type === 'signal' && obj.status === 'ready_for_next' && obj.cmdId) {
        signaledCmdIds.add(obj.cmdId);
      }
    } catch { /* skip */ }
  }
  if (signaledCmdIds.size > 0) {
    console.error(`[assistant-daemon] Recovered ${signaledCmdIds.size} already-signaled cmdIds.`);
  }
}

loadExistingSignals();

async function loop() {
  while (true) {
    const lines = readLines();

    // Check for session complete
    const isComplete = lines.some(l => {
      try { return JSON.parse(l).type === 'session_complete'; } catch { return false; }
    });
    if (isComplete) {
      console.error('[assistant-daemon] Session complete — exiting.');
      process.exit(0);
    }

    // Scan for command_executed events that haven't been signaled yet
    for (const line of lines) {
      let obj;
      try { obj = JSON.parse(line); } catch { continue; }

      if (obj.type === 'command_executed' && obj.cmdId && !signaledCmdIds.has(obj.cmdId)) {
        // Write ready_for_next to unblock the Pilot
        appendToSession({
          type: 'signal',
          status: 'ready_for_next',
          agentId,
          cmdId: obj.cmdId,
        });
        signaledCmdIds.add(obj.cmdId);
        console.error(`[assistant-daemon] Signaled ready_for_next for cmdId=${obj.cmdId}`);
      }
    }

    await sleep(POLL_MS);
  }
}

loop().catch(err => {
  console.error(`[assistant-daemon] Fatal: ${err.message}`);
  process.exit(1);
});
