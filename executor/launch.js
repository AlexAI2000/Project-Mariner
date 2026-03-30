#!/usr/bin/env node
// launch.js — Creates a session plan file and spawns executor.js as a detached background process.
// Usage: node /data/executor/launch.js '<plan-JSON>'
//        node /data/executor/launch.js --file /path/to/plan.json
//
// Plan JSON format:
// {
//   "clientId":  "john-doe",          // optional — enables auto-MultiLogin X + browser lifecycle
//   (platform removed — sessions are platform-agnostic)
//   "clientName": "John Doe",         // optional — used when creating a new client entry
//   "tasks": [
//     { "id": "task-1", "label": "Do X", "steps": [{action,...}, ...] },
//     { "id": "task-2", "type": "bash", "label": "Generate image", "command": "node ..." },
//     ...
//   ]
// }
//
// When clientId is set:
//   - executor resolves the MultiLogin X profile automatically (creates it via API if first time)
//   - mlProfileId + folderId are injected into all browser tasks (no need to set them manually)
//   - A humanized finalClose step is appended to the last browser task
//
// Outputs: { sessionId, pid, sessionPath, clientContext? }

import { writeFileSync, readFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { randomUUID } from 'crypto';
import { spawn, execSync } from 'child_process';

const __dir = dirname(fileURLToPath(import.meta.url));
const SESSIONS_DIR = '/data/sessions';
const EXECUTOR = join(__dir, 'executor.js');

mkdirSync(SESSIONS_DIR, { recursive: true });

const args = process.argv.slice(2);
if (args.length === 0) {
  console.error('Usage: node launch.js \'{"tasks":[...]}\' or --file plan.json');
  process.exit(1);
}

let planInput;
if (args[0] === '--file') {
  if (!args[1]) { console.error('--file requires a path'); process.exit(1); }
  planInput = readFileSync(args[1], 'utf8');
} else {
  planInput = args[0];
}

let plan;
try {
  plan = JSON.parse(planInput);
} catch (e) {
  console.error('Invalid JSON plan:', e.message);
  process.exit(1);
}

if (!Array.isArray(plan.tasks) || plan.tasks.length === 0) {
  console.error('Plan must have a non-empty "tasks" array');
  process.exit(1);
}

const sessionId = `session-${randomUUID()}`;
const sessionPath = join(SESSIONS_DIR, `${sessionId}.json`);

const tasks = plan.tasks.map((t, i) => ({
  id: t.id || `task-${i + 1}`,
  label: t.label || `Task ${i + 1}`,
  type: t.type || 'browser',
  // Browser task fields (legacy step-based)
  ...(t.steps ? { steps: t.steps } : {}),
  // browser-use task fields (natural language prompt)
  ...(t.prompt ? { prompt: t.prompt } : {}),
  ...(t.maxSteps ? { maxSteps: t.maxSteps } : {}),
  ...(t.timeout ? { timeout: t.timeout } : {}),
  // Bash task fields
  ...(t.command ? { command: t.command, timeoutSec: t.timeoutSec } : {}),
  // Client context (will be injected by executor if clientId is at plan level)
  ...(t.clientId ? { clientId: t.clientId } : {}),
  ...(t.mlProfileId ? { mlProfileId: t.mlProfileId } : {}),
  ...(t.folderId ? { folderId: t.folderId } : {}),
  status: 'pending',
  result: null,
}));

const session = {
  id: sessionId,
  createdAt: Date.now(),
  status: 'starting',

  // Session-level client context — executor resolves this before running tasks
  clientId: plan.clientId || null,
  clientName: plan.clientName || null,
  webhookUrl: plan.webhookUrl || null,
  clientContext: null, // filled by executor after resolveClient()

  tasks,
  executorPid: null,
  lastHeartbeat: Date.now(),
  watchdogCronName: `watchdog-${sessionId}`,
  result: null,
};

writeFileSync(sessionPath, JSON.stringify(session, null, 2));

// Spawn executor as detached background process (survives parent exit)
const child = spawn(process.execPath, [EXECUTOR, sessionId], {
  detached: true,
  stdio: ['ignore', 'ignore', 'ignore'],
  env: { ...process.env },
});
child.unref();

const pid = child.pid;

// Record pid in session
session.executorPid = pid;
session.status = 'running';
writeFileSync(sessionPath, JSON.stringify(session, null, 2));

// Register watchdog cron (every 5 minutes)
const cronName = session.watchdogCronName;
try {
  execSync(
    `openclaw cron add` +
    ` --name "${cronName}"` +
    ` --schedule "every 300000"` +
    ` --payload "agentTurn"` +
    ` --message "WATCHDOG: Check session ${sessionId}. Run: node /data/executor/watchdog.js ${sessionId}"` +
    ` --sessionTarget "isolated"` +
    ` --agent director`,
    { stdio: 'pipe', timeout: 15000 }
  );
} catch (e) {
  process.stderr.write(`Warning: watchdog cron registration failed: ${e.message}\n`);
  process.stderr.write('Session will still run — check progress manually with watchdog.js\n');
}

console.log(JSON.stringify({ sessionId, pid, sessionPath }, null, 2));
