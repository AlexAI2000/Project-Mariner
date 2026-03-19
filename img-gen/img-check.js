#!/usr/bin/env node
// img-check.js — Non-blocking check for image generation result.
//
// Usage: node /data/img-gen/img-check.js <requestId>
//
// Output:
//   { status: "pending" | "running" | "done" | "failed", result? }

import { readFileSync, existsSync, readdirSync } from 'fs';
import { join } from 'path';

const IMG_QUEUE = '/data/image-requests';
const PENDING   = join(IMG_QUEUE, 'pending');
const RUNNING   = join(IMG_QUEUE, 'running');
const DONE      = join(IMG_QUEUE, 'done');

const requestId = process.argv[2];
if (!requestId) {
  process.stderr.write('Usage: node img-check.js <requestId>\n');
  process.exit(1);
}

// Check done first (most common in polling loop)
const donePath    = join(DONE,    `${requestId}.json`);
const runningPath = join(RUNNING, `${requestId}.json`);
const pendingPath = join(PENDING, `${requestId}.json`);

if (existsSync(donePath)) {
  const req = JSON.parse(readFileSync(donePath, 'utf8'));
  console.log(JSON.stringify({ status: req.status, result: req.result }));
} else if (existsSync(runningPath)) {
  const req = JSON.parse(readFileSync(runningPath, 'utf8'));
  console.log(JSON.stringify({ status: 'running', claimedBy: req.claimedBy, claimedAt: req.claimedAt }));
} else if (existsSync(pendingPath)) {
  console.log(JSON.stringify({ status: 'pending' }));
} else {
  console.log(JSON.stringify({ status: 'not_found', requestId }));
  process.exit(1);
}
