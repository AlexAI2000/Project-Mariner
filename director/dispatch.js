#!/usr/bin/env node
// dispatch.js — Queue a browser task and wait for the result.
//
// Usage (steps only):
//   node dispatch.js '{"steps":[...]}' [--timeout 120]
//
// Usage (full task with client context):
//   node dispatch.js '{"steps":[...],"clientId":"john-doe","mlProfileId":"uuid","platform":"linkedin"}' [--timeout 120]
//
// Usage (clientId without mlProfileId — auto-resolves):
//   node dispatch.js '{"steps":[...],"clientId":"john-doe","platform":"linkedin"}' [--timeout 120]
//
// Writes task to pending/, polls done/ for result, prints JSON result to stdout.
// Exit 0: success  Exit 1: failure or timeout

import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { randomUUID } from 'crypto';
import { spawnSync } from 'child_process';

const __dir = dirname(fileURLToPath(import.meta.url));
const QUEUE_DIR = join(__dir, '../task-queue');
const PENDING = join(QUEUE_DIR, 'pending');
const DONE = join(QUEUE_DIR, 'done');

for (const sub of ['pending', 'running', 'done']) {
  mkdirSync(join(QUEUE_DIR, sub), { recursive: true });
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

const args = process.argv.slice(2);
if (args.length === 0) {
  console.error('Usage: node dispatch.js \'{"steps":[...]}\' [--timeout 120]');
  process.exit(1);
}

const timeoutIdx = args.indexOf('--timeout');
const timeoutSec = timeoutIdx >= 0 ? parseInt(args[timeoutIdx + 1]) : 300;
const taskInput = args[0];

let taskBody;
try {
  // Support file path input: if arg starts with / or ./ treat as a JSON file
  let rawJson = taskInput;
  if (taskInput && (taskInput.startsWith('/') || taskInput.startsWith('./'))) {
    rawJson = readFileSync(taskInput, 'utf8');
  }
  taskBody = JSON.parse(rawJson);
} catch (e) {
  console.error('Invalid JSON task:', e.message);
  process.exit(1);
}

// Auto-resolve mlProfileId if clientId + platform provided but no profileId
if (taskBody.clientId && taskBody.platform && !taskBody.mlProfileId) {
  const result = spawnSync(process.execPath, [
    '/data/executor/pa-lookup.js',
    taskBody.clientId,
    taskBody.platform,
  ], { encoding: 'utf8', timeout: 60000 });

  if (result.status !== 0) {
    const errMsg = result.stderr?.trim() || `pa-lookup exited ${result.status}`;
    console.error(`dispatch: failed to resolve client context for ${taskBody.clientId}/${taskBody.platform}: ${errMsg}`);
    process.exit(1);
  }

  try {
    const ctx = JSON.parse(result.stdout.trim());
    taskBody.mlProfileId = ctx.mlProfileId;
    taskBody.folderId = ctx.folderId;
    process.stderr.write(`[dispatch] Resolved mlProfileId=${ctx.mlProfileId} for ${taskBody.clientId}/${taskBody.platform}\n`);
  } catch (e) {
    console.error(`dispatch: pa-lookup returned invalid JSON: ${result.stdout.slice(0, 200)}`);
    process.exit(1);
  }
}

const id = randomUUID();
const task = {
  id,
  createdAt: Date.now(),
  ...taskBody,
};

const pendingPath = join(PENDING, `${id}.json`);
const donePath = join(DONE, `${id}.json`);

writeFileSync(pendingPath, JSON.stringify(task, null, 2));

// Poll for completion
const deadline = Date.now() + timeoutSec * 1000;
while (Date.now() < deadline) {
  if (existsSync(donePath)) {
    const result = JSON.parse(readFileSync(donePath, 'utf8'));
    console.log(JSON.stringify(result.result, null, 2));
    process.exit(result.result?.success ? 0 : 1);
  }
  await sleep(500);
}

console.error(JSON.stringify({ success: false, error: 'timeout', taskId: id }));
process.exit(1);
