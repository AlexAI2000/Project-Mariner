#!/usr/bin/env node
// img-claim.js — Atomically claim a pending image request from the queue.
//
// Usage: node /data/img-gen/img-claim.js <agentId>
//
// Output:
//   Claimed request JSON (stdout) if work is available
//   "null" (stdout) if queue is empty

import { readdirSync, readFileSync, writeFileSync, renameSync } from 'fs';
import { join } from 'path';

const IMG_QUEUE = '/data/image-requests';
const PENDING   = join(IMG_QUEUE, 'pending');
const RUNNING   = join(IMG_QUEUE, 'running');

const agentId = process.argv[2] || 'unknown';

let files;
try {
  files = readdirSync(PENDING).filter(f => f.endsWith('.json')).sort();
} catch {
  files = [];
}

for (const file of files) {
  const pendingPath = join(PENDING, file);
  const runningPath = join(RUNNING, file);

  try {
    // Atomic rename — only one agent wins the race
    renameSync(pendingPath, runningPath);
  } catch {
    // Another agent claimed it first — try next
    continue;
  }

  // We own it — stamp our claim
  const request = JSON.parse(readFileSync(runningPath, 'utf8'));
  request.claimedBy  = agentId;
  request.claimedAt  = Date.now();
  request.status     = 'running';
  writeFileSync(runningPath, JSON.stringify(request, null, 2));

  console.log(JSON.stringify(request));
  process.exit(0);
}

// Nothing available
console.log('null');
process.exit(0);
