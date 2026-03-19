#!/usr/bin/env node
// Director daemon — manages 10 browser workers and a file-based task queue

import { Worker } from 'worker_threads';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { mkdirSync, existsSync } from 'fs';

const __dir = dirname(fileURLToPath(import.meta.url));
const WORKER_COUNT = 10;
const WORKER_SCRIPT = join(__dir, 'worker.js');

const QUEUE_DIR = join(__dir, '../task-queue');
for (const sub of ['pending', 'running', 'done']) {
  mkdirSync(join(QUEUE_DIR, sub), { recursive: true });
}

const workers = new Map(); // workerId → { worker, status }

function log(msg) {
  console.log(`[director] ${new Date().toISOString()} ${msg}`);
}

function spawnWorker(id) {
  const worker = new Worker(WORKER_SCRIPT, {
    workerData: { workerId: id },
    // Pass through module resolution
    execArgv: ['--experimental-vm-modules'],
  });

  workers.set(id, { worker, status: 'starting', currentTask: null });

  worker.on('message', msg => {
    switch (msg.type) {
      case 'ready':
        workers.get(id).status = 'idle';
        workers.get(id).currentTask = null;
        log(`worker-${id} idle`);
        break;
      case 'busy':
        workers.get(id).status = 'busy';
        workers.get(id).currentTask = msg.taskId;
        log(`worker-${id} running task ${msg.taskId}`);
        break;
      case 'log':
        log(`worker-${id}: ${msg.msg}`);
        break;
      case 'error':
        log(`worker-${id} error: ${msg.msg}`);
        break;
    }
  });

  worker.on('error', err => {
    log(`worker-${id} crashed: ${err.message} — restarting in 3s`);
    workers.delete(id);
    setTimeout(() => spawnWorker(id), 3000);
  });

  worker.on('exit', code => {
    if (code !== 0) {
      log(`worker-${id} exited (${code}) — restarting in 3s`);
      workers.delete(id);
      setTimeout(() => spawnWorker(id), 3000);
    }
  });
}

// Boot all workers
for (let i = 1; i <= WORKER_COUNT; i++) {
  spawnWorker(i);
}

log(`Director started with ${WORKER_COUNT} workers`);
log(`Task queue: ${QUEUE_DIR}`);

// Status report every 60s
setInterval(() => {
  const idle = [...workers.values()].filter(w => w.status === 'idle').length;
  const busy = [...workers.values()].filter(w => w.status === 'busy').length;
  log(`status: ${idle} idle, ${busy} busy, ${WORKER_COUNT - idle - busy} starting`);
}, 60000);

// Keep process alive
process.on('SIGTERM', () => {
  log('shutting down');
  for (const { worker } of workers.values()) worker.terminate();
  process.exit(0);
});

process.on('SIGINT', () => {
  log('shutting down');
  for (const { worker } of workers.values()) worker.terminate();
  process.exit(0);
});
