#!/usr/bin/env node
// trigger-working-session.js — Launches a Mariner Apex team for a working session.
// Selects the appropriate Pilot agent (round-robin), then delegates
// full team spawning (Pilot + Humanizer + Assistant + 3 Watchdogs) to spawn-team.js.
//
// Usage: node trigger-working-session.js <accountId> <clientName> <tasksJson> <callbackUrl> <executionId>
// Output: JSON { success, pid, sessionId, worker, logFile } to stdout (returns immediately)
// Exit 0: team triggered  Exit 1: error

import { spawn } from 'child_process';
import { randomUUID } from 'crypto';
import { readFileSync, writeFileSync, existsSync } from 'fs';

const [, , accountId, clientName, tasksRaw, callbackUrl, executionId] = process.argv;

if (!accountId || !clientName || !tasksRaw || !callbackUrl || !executionId) {
  console.error('Usage: node trigger-working-session.js <accountId> <clientName> <tasksJson> <callbackUrl> <executionId>');
  process.exit(1);
}

let tasks;
try {
  tasks = JSON.parse(tasksRaw);
} catch {
  console.error('Invalid tasks JSON');
  process.exit(1);
}

// ── Pilot selection (round-robin across all 10 Mariner Pilots) ───────────────

const PILOTS = [
  'worker-1', 'worker-2', 'worker-3', 'worker-4', 'worker-5',
  'worker-6', 'worker-7', 'worker-8', 'worker-9', 'worker-10',
];

const COUNTER_FILE = `/tmp/mariner-counter.json`;

function pickPilot() {
  const pool = PILOTS;
  let counter = 0;
  try {
    counter = JSON.parse(readFileSync(COUNTER_FILE, 'utf8')).counter || 0;
  } catch { /* first run */ }
  const pilot = pool[counter % pool.length];
  writeFileSync(COUNTER_FILE, JSON.stringify({ counter: counter + 1 }));
  return pilot;
}

const pilotName = pickPilot();
const sessionId = `ws-${accountId}-${randomUUID().slice(0, 8)}`;

// ── Delegate to spawn-team.js ─────────────────────────────────────────────────

const spawnTeamArgs = [
  '/data/mariner/spawn-team.js',
  sessionId,
  pilotName,
  accountId,
  clientName,
  tasksRaw,
  callbackUrl,
  executionId,
];

const child = spawn('node', spawnTeamArgs, {
  stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env },
});

let stdout = '';
let stderr = '';
child.stdout.on('data', d => { stdout += d.toString(); });
child.stderr.on('data', d => { stderr += d.toString(); });

child.on('close', code => {
  if (code !== 0) {
    console.error(`spawn-team.js failed (exit ${code}): ${stderr}`);
    console.log(JSON.stringify({ success: false, error: stderr || 'spawn-team failed', sessionId }));
    process.exit(1);
  }

  try {
    const result = JSON.parse(stdout.trim());
    // Return format compatible with existing callers (task-api.js)
    console.log(JSON.stringify({
      success: true,
      pid: result.pids?.pilot,
      worker: pilotName,
      logFile: result.logs?.pilot,
      sessionId: result.sessionId,
      teamPids: result.pids,
      message: result.message,
    }));
  } catch {
    // Passthrough raw output
    process.stdout.write(stdout);
  }
});
