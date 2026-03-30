#!/usr/bin/env node
// executor.js — Long-running background process that executes a session plan.
// Usage: node /data/executor/executor.js <sessionId>
// Never call this directly — use launch.js.
//
// Recovery: if restarted, skips tasks already marked "done" or "skipped".
// Lock file prevents double-execution. Heartbeat updated every ~60s during dispatch.
//
// Session-level client context:
//   If plan.clientId is set, resolves MultiLogin X profile ONCE at session start
//   and automatically injects mlProfileId + folderId + clientId into every browser task.
//   A finalClose step is appended to the last browser task to humanize-close the browser.

import { readFileSync, writeFileSync, existsSync, unlinkSync } from 'fs';
import { join } from 'path';
import { spawn } from 'child_process';
import { runBrowserUseTask } from '/data/browser-use/bridge.js';

const SESSIONS_DIR = '/data/sessions';
const DISPATCH = '/data/director/dispatch.js';
const CLIENT_MANAGER = '/data/clients/client-manager.js';
const HOOKS_URL = 'http://127.0.0.1:18789/__openclaw__/hooks/hooks_9O0IWy8zIq5tGAIEC5YrF9MXxZlhiEbq';
const HEARTBEAT_INTERVAL_MS = 60_000;
const DISPATCH_TIMEOUT_SEC = 540; // 9 min — leaves margin under 10 min bash limit
const BASH_TASK_TIMEOUT_SEC = 1800; // 30 min max for bash tasks (e.g. image gen)

const sessionId = process.argv[2];
if (!sessionId) {
  process.stderr.write('Usage: node executor.js <sessionId>\n');
  process.exit(1);
}

const sessionPath = join(SESSIONS_DIR, `${sessionId}.json`);
const lockPath = `${sessionPath}.lock`;

// Acquire lock — bail if another live executor holds it (lock age < 8 min)
if (existsSync(lockPath)) {
  const lockAge = Date.now() - (parseInt(readFileSync(lockPath, 'utf8')) || 0);
  if (lockAge < 8 * 60 * 1000) {
    process.stderr.write(`[executor] Lock held by another process (age ${Math.round(lockAge / 1000)}s). Exiting.\n`);
    process.exit(0);
  }
}
writeFileSync(lockPath, String(Date.now()));

function releaseLock() {
  try { unlinkSync(lockPath); } catch {}
}

function readSession() {
  return JSON.parse(readFileSync(sessionPath, 'utf8'));
}

function writeSession(session) {
  writeFileSync(sessionPath, JSON.stringify(session, null, 2));
}

function heartbeat(session) {
  session.lastHeartbeat = Date.now();
  session.executorPid = process.pid;
  writeSession(session);
}

// ── Client context resolution ─────────────────────────────────────────────────

// Resolve MultiLogin X profile for the session's clientId.
// Calls client-manager.js as a subprocess so it can do async MultiLogin API calls.
// Returns clientContext object or null if no clientId is set.
async function resolveClientContext(clientId, clientName = null) {
  if (!clientId) return null;

  return new Promise((resolve, reject) => {
    const cliArgs = [CLIENT_MANAGER, 'resolve', clientId];
    if (clientName) cliArgs.push(clientName);

    const proc = spawn(process.execPath, cliArgs, { stdio: ['ignore', 'pipe', 'pipe'] });

    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', d => { stdout += d; });
    proc.stderr.on('data', d => { stderr += d; process.stderr.write(d); });

    const timer = setTimeout(() => {
      proc.kill('SIGTERM');
      reject(new Error(`resolveClientContext timed out (60s) for ${clientId}`));
    }, 60000);

    proc.on('close', code => {
      clearTimeout(timer);
      if (code === 0) {
        try { resolve(JSON.parse(stdout.trim())); }
        catch (e) { reject(new Error(`client-manager bad JSON: ${stdout.slice(0, 200)}`)); }
      } else {
        reject(new Error(stderr.trim() || `client-manager exited ${code}`));
      }
    });

    proc.on('error', err => { clearTimeout(timer); reject(err); });
  });
}

// ── Task dispatch ─────────────────────────────────────────────────────────────

// Dispatch a browser task to HumanBrowser via dispatch.js.
// task must include steps[]. If clientContext is set, mlProfileId + folderId + clientId are injected.
// Sends heartbeat every 60s while waiting.
function dispatchTask(task) {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, [
      DISPATCH,
      JSON.stringify(task),
      '--timeout', String(DISPATCH_TIMEOUT_SEC),
    ], { stdio: ['ignore', 'pipe', 'pipe'] });

    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', d => { stdout += d; });
    proc.stderr.on('data', d => { stderr += d; });

    // Heartbeat while waiting for dispatch
    const hbTimer = setInterval(() => {
      try {
        const s = readSession();
        s.lastHeartbeat = Date.now();
        writeSession(s);
      } catch {}
    }, HEARTBEAT_INTERVAL_MS);

    const guardTimer = setTimeout(() => {
      clearInterval(hbTimer);
      proc.kill('SIGTERM');
      reject(new Error(`dispatch timed out after ${DISPATCH_TIMEOUT_SEC}s`));
    }, (DISPATCH_TIMEOUT_SEC + 60) * 1000);

    proc.on('close', code => {
      clearInterval(hbTimer);
      clearTimeout(guardTimer);
      if (code === 0) {
        try { resolve(JSON.parse(stdout.trim())); }
        catch (e) { reject(new Error(`dispatch bad JSON: ${stdout.slice(0, 200)}`)); }
      } else {
        // dispatch.js may still write JSON to stdout on failure
        try { resolve(JSON.parse(stdout.trim())); }
        catch { reject(new Error(stderr.trim() || `dispatch exited ${code}`)); }
      }
    });

    proc.on('error', err => {
      clearInterval(hbTimer);
      clearTimeout(guardTimer);
      reject(err);
    });
  });
}

// Run an arbitrary shell command as a task (for bash-type tasks, e.g. img-dispatch).
function runBashTask(command, timeoutSec) {
  return new Promise((resolve, reject) => {
    const proc = spawn('bash', ['-c', command], { stdio: ['ignore', 'pipe', 'pipe'] });

    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', d => { stdout += d; });
    proc.stderr.on('data', d => { stderr += d; });

    const hbTimer = setInterval(() => {
      try {
        const s = readSession();
        s.lastHeartbeat = Date.now();
        writeSession(s);
      } catch {}
    }, HEARTBEAT_INTERVAL_MS);

    const guardTimer = setTimeout(() => {
      clearInterval(hbTimer);
      proc.kill('SIGTERM');
      resolve({ success: false, output: stdout.slice(0, 1000), error: `bash task timed out after ${timeoutSec}s` });
    }, timeoutSec * 1000);

    proc.on('close', code => {
      clearInterval(hbTimer);
      clearTimeout(guardTimer);
      const output = stdout.trim().slice(0, 2000);
      const errOut = stderr.trim().slice(0, 500);
      if (code === 0) {
        resolve({ success: true, output, error: null });
      } else {
        resolve({ success: false, output, error: errOut || `exit code ${code}` });
      }
    });

    proc.on('error', err => {
      clearInterval(hbTimer);
      clearTimeout(guardTimer);
      resolve({ success: false, output: '', error: err.message });
    });
  });
}

// ── Completion notification ───────────────────────────────────────────────────

async function notifyCompletion(session) {
  const lines = session.tasks.map(t => {
    const icon = t.status === 'done' ? '[OK]' : '[FAIL]';
    const detail = t.result?.summary || t.result?.error || t.status;
    return `${icon} ${t.label}: ${detail}`;
  });
  const message = `SESSION COMPLETE [${session.id}]\n\n${lines.join('\n')}`;

  try {
    await new Promise((resolve, reject) => {
      const proc = spawn('curl', [
        '-s', '-X', 'POST',
        '-H', 'Content-Type: application/json',
        '-d', JSON.stringify({ message, agent: 'main' }),
        '--max-time', '10',
        HOOKS_URL,
      ], { stdio: 'pipe' });
      proc.on('close', code => code === 0 ? resolve() : reject(new Error(`curl exit ${code}`)));
      proc.on('error', reject);
    });
    process.stderr.write('[executor] Completion notification sent via hooks API.\n');
    return;
  } catch (e) {
    process.stderr.write(`[executor] Hooks notify failed (${e.message}) — session file is source of truth.\n`);
  }

  writeFileSync(`${sessionPath}.completed`, message);
}

// ── Lovable / Mariner callback ───────────────────────────────────────────────
// Fires the callback_url (or legacy webhookUrl) with execution_id + session result.

async function callLovableCallback(session) {
  const callbackUrl = session.callbackUrl || session.webhookUrl;
  if (!callbackUrl) return;

  const callbackMetadata = session.callbackMetadata || {};
  const executionId = callbackMetadata.execution_id || null;

  const allOk = session.tasks.every(t => t.status === 'done' || t.status === 'skipped');

  const payload = {
    execution_id: executionId,
    session_id: session.id,
    account_id: session.clientId || null,
    client_name: session.clientName || null,
    status: allOk ? 'completed' : 'failed',
    tasks_completed: session.tasks.filter(t => t.status === 'done').length,
    tasks_total: session.tasks.length,
    message: allOk
      ? 'Session completed successfully.'
      : `Session failed: ${session.error || 'unknown error'}`,
    tasks: session.tasks.map(t => ({
      id: t.id,
      label: t.label,
      status: t.status,
      error: t.result?.error || undefined,
    })),
    completedAt: session.completedAt,
  };

  try {
    await new Promise((resolve, reject) => {
      const proc = spawn('curl', [
        '-s', '-X', 'POST',
        '-H', 'Content-Type: application/json',
        '-d', JSON.stringify(payload),
        '--max-time', '15',
        callbackUrl,
      ], { stdio: ['ignore', 'pipe', 'pipe'] });

      let out = '';
      let errOut = '';
      proc.stdout.on('data', d => { out += d; });
      proc.stderr.on('data', d => { errOut += d; });

      proc.on('close', code => {
        process.stderr.write(`[executor] Lovable callback → ${callbackUrl} (${code}): ${out.slice(0, 200)}\n`);
        code === 0 ? resolve() : reject(new Error(errOut || `curl exit ${code}`));
      });
      proc.on('error', reject);
    });
  } catch (e) {
    process.stderr.write(`[executor] Lovable callback failed: ${e.message}\n`);
  }
}

// ── Main session loop ─────────────────────────────────────────────────────────

async function runSession() {
  if (!existsSync(sessionPath)) {
    process.stderr.write(`[executor] Session file not found: ${sessionPath}\n`);
    process.exit(1);
  }

  let session = readSession();
  session.status = 'running';
  session.executorPid = process.pid;
  session.lastHeartbeat = Date.now();
  writeSession(session);

  process.stderr.write(`[executor] Starting session ${sessionId} (${session.tasks.length} tasks)\n`);

  // ── Resolve client context once for the entire session ────────────────────
  let clientContext = session.clientContext || null;

  if (!clientContext && session.clientId) {
    process.stderr.write(`[executor] Resolving client context for ${session.clientId}...\n`);
    try {
      clientContext = await resolveClientContext(session.clientId, session.clientName || null);
      session.clientContext = clientContext;
      if (clientContext.isNew) {
        session.clientContextNote = `MultiLogin X profile auto-created: ${clientContext.mlProfileId}`;
      }
      writeSession(session);
      process.stderr.write(`[executor] Client resolved: ${clientContext.clientName}, profile=${clientContext.mlProfileId}, isNew=${clientContext.isNew}\n`);
    } catch (e) {
      process.stderr.write(`[executor] Failed to resolve client context: ${e.message}\n`);
      session.status = 'error';
      session.error = `Client resolution failed: ${e.message}`;
      writeSession(session);
      releaseLock();
      process.exit(1);
    }
  }

  // ── Inject mlProfileId + folderId into all browser tasks ─────────────────
  // Also append finalClose to the last browser task so the session closes humanely.
  if (clientContext?.mlProfileId) {
    let lastBrowserTaskIdx = -1;

    for (let i = 0; i < session.tasks.length; i++) {
      const t = session.tasks[i];
      if (t.type === 'bash') continue; // bash tasks don't touch the browser

      // Inject client context
      session.tasks[i] = {
        ...t,
        clientId: clientContext.clientId,
        mlProfileId: clientContext.mlProfileId,
        folderId: clientContext.folderId,
      };
      lastBrowserTaskIdx = i;
    }

    // Append finalClose to the last legacy browser task so the session ends gracefully.
    // Skip browser_use tasks — they don't use steps, and the MLX profile stays open for reuse.
    if (lastBrowserTaskIdx >= 0) {
      const lt = session.tasks[lastBrowserTaskIdx];
      if (lt.type !== 'browser_use') {
        const steps = Array.isArray(lt.steps) ? lt.steps : [];
        // Only add if not already there (recovery guard)
        if (!steps.some(s => s.action === 'finalClose')) {
          session.tasks[lastBrowserTaskIdx] = {
            ...lt,
            steps: [...steps, { action: 'finalClose' }],
          };
        }
      }
    }

    writeSession(session);
  }

  // ── Execute tasks ─────────────────────────────────────────────────────────
  for (let i = 0; i < session.tasks.length; i++) {
    session = readSession();
    const task = session.tasks[i];

    if (task.status === 'done' || task.status === 'skipped') {
      process.stderr.write(`[executor] Task ${task.id} already ${task.status}, skipping.\n`);
      continue;
    }

    // ── Bash task ──────────────────────────────────────────────────────────
    if (task.type === 'bash') {
      if (!task.command) {
        process.stderr.write(`[executor] Bash task ${task.id} has no command, marking skipped.\n`);
        session.tasks[i] = { ...task, status: 'skipped', result: { summary: 'No command defined' } };
        heartbeat(session);
        continue;
      }

      process.stderr.write(`[executor] Running bash task ${task.id}: ${task.label}\n`);
      session.tasks[i] = { ...task, status: 'running', startedAt: Date.now() };
      heartbeat(session);

      const timeoutSec = task.timeoutSec || BASH_TASK_TIMEOUT_SEC;
      const bashResult = await runBashTask(task.command, timeoutSec);
      const summary = bashResult.output.slice(0, 500) || (bashResult.success ? 'Completed' : bashResult.error || 'Failed');

      session = readSession();
      session.tasks[i] = {
        ...session.tasks[i],
        status: bashResult.success ? 'done' : 'failed',
        completedAt: Date.now(),
        result: { success: bashResult.success, summary, output: bashResult.output, error: bashResult.error },
      };
      heartbeat(session);
      process.stderr.write(`[executor] Bash task ${task.id} ${bashResult.success ? 'done' : 'FAILED'}: ${bashResult.error || 'ok'}\n`);
      continue;
    }

    // ── browser-use task (AI agent with natural language prompt) ──────────
    if (task.type === 'browser_use') {
      if (!task.prompt) {
        process.stderr.write(`[executor] browser_use task ${task.id} has no prompt, marking skipped.\n`);
        session.tasks[i] = { ...task, status: 'skipped', result: { summary: 'No prompt defined' } };
        heartbeat(session);
        continue;
      }

      // Need a CDP URL — either from task directly, or start the MLX profile
      let cdpUrl = task.cdpUrl || null;
      if (!cdpUrl && task.mlProfileId) {
        process.stderr.write(`[executor] Starting MLX profile ${task.mlProfileId} for browser_use task...\n`);
        try {
          const startProfileResult = await new Promise((resolve, reject) => {
            const proc = spawn(process.execPath, [
              '-e',
              `import('file:///data/multilogin/multilogin.js').then(m => m.startProfile('${task.mlProfileId}', '${task.folderId || ''}')).then(url => { process.stdout.write(url); process.exit(0); }).catch(e => { process.stderr.write(e.message); process.exit(1); })`,
            ], { stdio: ['ignore', 'pipe', 'pipe'] });

            let out = '';
            let errOut = '';
            proc.stdout.on('data', d => { out += d; });
            proc.stderr.on('data', d => { errOut += d; process.stderr.write(d); });
            const timer = setTimeout(() => { proc.kill('SIGTERM'); reject(new Error('startProfile timed out (120s)')); }, 120000);
            proc.on('close', code => {
              clearTimeout(timer);
              code === 0 ? resolve(out.trim()) : reject(new Error(errOut.trim() || `startProfile exit ${code}`));
            });
            proc.on('error', err => { clearTimeout(timer); reject(err); });
          });
          cdpUrl = startProfileResult;
        } catch (e) {
          process.stderr.write(`[executor] Failed to start MLX profile for browser_use: ${e.message}\n`);
          session = readSession();
          session.tasks[i] = {
            ...session.tasks[i],
            status: 'failed',
            completedAt: Date.now(),
            result: { success: false, summary: '', error: `MLX profile start failed: ${e.message}` },
          };
          heartbeat(session);
          continue;
        }
      }

      if (!cdpUrl) {
        process.stderr.write(`[executor] browser_use task ${task.id} has no cdpUrl and no mlProfileId, marking failed.\n`);
        session.tasks[i] = { ...task, status: 'failed', result: { success: false, error: 'No CDP URL or MLX profile available' } };
        heartbeat(session);
        continue;
      }

      process.stderr.write(`[executor] Running browser_use task ${task.id}: ${task.prompt.slice(0, 100)}...\n`);
      session.tasks[i] = { ...task, status: 'running', startedAt: Date.now() };
      heartbeat(session);

      try {
        const buResult = await runBrowserUseTask(task.prompt, cdpUrl, {
          maxSteps: task.maxSteps || 100,
          timeout: task.timeout || 600,
        });

        session = readSession();
        session.tasks[i] = {
          ...session.tasks[i],
          status: buResult.success ? 'done' : 'failed',
          completedAt: Date.now(),
          result: {
            success: buResult.success,
            summary: buResult.result || (buResult.success ? 'Completed' : 'Failed'),
            error: buResult.success ? undefined : (buResult.errors?.[0] || 'Unknown error'),
            steps: buResult.steps,
            duration_ms: buResult.duration_ms,
          },
        };
      } catch (e) {
        process.stderr.write(`[executor] browser_use task ${task.id} threw: ${e.message}\n`);
        session = readSession();
        session.tasks[i] = {
          ...session.tasks[i],
          status: 'failed',
          completedAt: Date.now(),
          result: { success: false, summary: '', error: e.message },
        };
      }

      heartbeat(session);
      process.stderr.write(`[executor] browser_use task ${task.id} ${session.tasks[i].status}.\n`);
      continue;
    }

    // ── Legacy browser task (step-based dispatch) ───────────────────────────
    if (!task.steps || task.steps.length === 0) {
      process.stderr.write(`[executor] Task ${task.id} has no steps, marking skipped.\n`);
      session.tasks[i] = { ...task, status: 'skipped', result: { summary: 'No steps defined' } };
      heartbeat(session);
      continue;
    }

    process.stderr.write(`[executor] Running task ${task.id}: ${task.label}\n`);
    session.tasks[i] = { ...task, status: 'running', startedAt: Date.now() };
    heartbeat(session);

    let dispatchResult = null;
    let lastError = null;

    // Try dispatch, retry once on failure
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        dispatchResult = await dispatchTask(task);
        if (dispatchResult?.success) break;
        lastError = dispatchResult?.error || 'dispatch returned success=false';
      } catch (e) {
        lastError = e.message;
        process.stderr.write(`[executor] Task ${task.id} attempt ${attempt} failed: ${lastError}\n`);
        if (attempt < 2) await new Promise(r => setTimeout(r, 3000)); // brief pause before retry
      }
    }

    const success = dispatchResult?.success === true;
    const textParts = (dispatchResult?.results || []).filter(Boolean);
    const summary = textParts.join('\n').slice(0, 500) || (success ? 'Completed' : lastError || 'Failed');

    session = readSession();
    session.tasks[i] = {
      ...session.tasks[i],
      status: success ? 'done' : 'failed',
      completedAt: Date.now(),
      result: { success, summary, error: success ? undefined : lastError },
    };
    heartbeat(session);
    process.stderr.write(`[executor] Task ${task.id} ${success ? 'done' : 'FAILED'}.\n`);
  }

  // ── Finalize session ──────────────────────────────────────────────────────
  session = readSession();
  const allOk = session.tasks.every(t => t.status === 'done' || t.status === 'skipped');
  session.status = 'done';
  session.completedAt = Date.now();
  session.result = {
    success: allOk,
    summary: session.tasks.map(t => `${t.label}: ${t.status}`).join('; '),
  };
  writeSession(session);

  process.stderr.write(`[executor] Session ${sessionId} complete. All OK: ${allOk}\n`);

  await notifyCompletion(session);
  await callLovableCallback(session);
  releaseLock();
}

runSession().catch(e => {
  process.stderr.write(`[executor] Fatal error: ${e.message}\n${e.stack}\n`);
  try {
    const session = readSession();
    session.status = 'error';
    session.error = e.message;
    session.lastHeartbeat = Date.now();
    writeSession(session);
  } catch {}
  releaseLock();
  process.exit(1);
});
