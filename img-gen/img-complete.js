#!/usr/bin/env node
// img-complete.js — Mark an image request as done (success or failure).
//
// Usage:
//   node /data/img-gen/img-complete.js <requestId> '<result-json>'
//
// Result JSON fields:
//   success  (boolean)
//   images   (array of absolute file paths)
//   summary  (string description)
//   error    (string, only on failure)
//
// Example (success):
//   node /data/img-gen/img-complete.js abc-123 '{"success":true,"images":["/data/generated-images/abc-123/image-1.png"],"summary":"Generated LinkedIn profile photo"}'
//
// Example (failure):
//   node /data/img-gen/img-complete.js abc-123 '{"success":false,"images":[],"error":"Gemini rate limited after 3 attempts"}'

import { readFileSync, writeFileSync, renameSync, existsSync } from 'fs';
import { join } from 'path';

const IMG_QUEUE = '/data/image-requests';
const RUNNING   = join(IMG_QUEUE, 'running');
const DONE      = join(IMG_QUEUE, 'done');

const requestId = process.argv[2];
const resultArg = process.argv[3];

if (!requestId || !resultArg) {
  process.stderr.write('Usage: node img-complete.js <requestId> <result-json>\n');
  process.exit(1);
}

let result;
try {
  result = JSON.parse(resultArg);
} catch (e) {
  process.stderr.write(`Invalid result JSON: ${e.message}\n`);
  process.exit(1);
}

const runningPath = join(RUNNING, `${requestId}.json`);
const donePath    = join(DONE,    `${requestId}.json`);

if (!existsSync(runningPath)) {
  process.stderr.write(`Request ${requestId} not found in running queue.\n`);
  process.exit(1);
}

const request = JSON.parse(readFileSync(runningPath, 'utf8'));
request.result      = result;
request.completedAt = Date.now();
request.status      = result.success ? 'done' : 'failed';

writeFileSync(donePath, JSON.stringify(request, null, 2));
try { renameSync(runningPath, donePath); } catch {}  // idempotent — donePath already written

console.log(JSON.stringify({ success: true, requestId, status: request.status }));
