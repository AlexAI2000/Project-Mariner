#!/usr/bin/env node
// img-dispatch.js — Queue an image generation request and wait for result.
//
// Usage:
//   node /data/img-gen/img-dispatch.js '<json>' [--timeout 1200] [--nowait]
//
// Input JSON fields:
//   prompt      (required) — raw image requirement (will be refined by img-gen agent)
//   count       (default 1) — number of images to generate
//   outputDir   (required) — where to save the generated images
//   context     (optional) — purpose description, e.g. "linkedin profile photo for John Doe"
//   callerLabel (optional) — who is making the request (for logging)
//
// Flags:
//   --timeout N  — wait up to N seconds (default 1200 = 20 min)
//   --nowait     — return immediately with requestId (don't wait for result)
//
// Output (stdout):
//   { success, requestId, images: ["/path/to/image.png"], summary }
//   or with --nowait: { requestId, status: "pending", checkWith: "node /data/img-gen/img-check.js <requestId>" }

import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { randomUUID } from 'crypto';

const IMG_QUEUE = '/data/image-requests';
const PENDING   = join(IMG_QUEUE, 'pending');
const DONE      = join(IMG_QUEUE, 'done');

for (const sub of ['pending', 'running', 'done']) {
  mkdirSync(join(IMG_QUEUE, sub), { recursive: true });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

const args = process.argv.slice(2);
if (args.length === 0) {
  process.stderr.write(
    'Usage: node img-dispatch.js \'{"prompt":"...","outputDir":"/data/generated-images/client-x/"}\' [--timeout 1200] [--nowait]\n'
  );
  process.exit(1);
}

const timeoutIdx = args.indexOf('--timeout');
const timeoutSec = timeoutIdx >= 0 ? parseInt(args[timeoutIdx + 1]) : 1200;
const nowait     = args.includes('--nowait');

let input;
try {
  input = JSON.parse(args[0]);
} catch (e) {
  process.stderr.write(`Invalid JSON: ${e.message}\n`);
  process.exit(1);
}

if (!input.prompt) {
  process.stderr.write('Error: "prompt" is required\n');
  process.exit(1);
}
if (!input.outputDir) {
  process.stderr.write('Error: "outputDir" is required\n');
  process.exit(1);
}

const requestId = randomUUID();
mkdirSync(input.outputDir, { recursive: true });

const request = {
  id:          requestId,
  createdAt:   Date.now(),
  prompt:      input.prompt,
  count:       input.count || 1,
  outputDir:   input.outputDir,
  context:     input.context || '',
  callerLabel: input.callerLabel || 'unknown',
  status:      'pending',
};

const pendingPath = join(PENDING, `${requestId}.json`);
const donePath    = join(DONE,    `${requestId}.json`);

writeFileSync(pendingPath, JSON.stringify(request, null, 2));
process.stderr.write(`[img-dispatch] Request ${requestId} queued in ${PENDING}\n`);

if (nowait) {
  console.log(JSON.stringify({
    requestId,
    status: 'pending',
    checkWith: `node /data/img-gen/img-check.js ${requestId}`,
  }, null, 2));
  process.exit(0);
}

// Poll every 10 seconds until done or timeout
process.stderr.write(`[img-dispatch] Waiting up to ${timeoutSec}s for result...\n`);
const deadline = Date.now() + timeoutSec * 1000;

while (Date.now() < deadline) {
  if (existsSync(donePath)) {
    const done = JSON.parse(readFileSync(donePath, 'utf8'));
    console.log(JSON.stringify(done.result, null, 2));
    process.exit(done.result?.success ? 0 : 1);
  }
  await sleep(10_000);
}

console.error(JSON.stringify({
  success:   false,
  error:     'timeout — no img-gen agent processed the request in time',
  requestId,
  hint:      'Ensure img-gen crons are active and img-gen agents have valid MultiLogin X profiles.',
}));
process.exit(1);
