#!/usr/bin/env node
// humanizer.js — Mariner Behavioral Decision Engine
//
// Called by humanizer-daemon.js before executing every Playwright command.
// Reads the session's humanizer sidecar JSONL for history, then generates
// a fresh, anti-pattern-enforced execution sequence that wraps the raw command
// in realistic human behavioral noise.
//
// Always appends a snapshot at the end so the Pilot receives a fresh
// accessibility tree as the return value of every action it submits.
//
// Usage:
//   node /data/mariner/humanizer.js '<json-input>'
//
// Input JSON:
//   { rawCommand, sessionId, sidecarFile }
//
// Output JSON (stdout):
//   { sequence: [cmd, ...], logEntry: { action, ... } }
//
// Exit 0: success   Exit 1: error (caller should fallback to raw command)

import { readFileSync, appendFileSync, existsSync } from 'fs';

// ── Constants ─────────────────────────────────────────────────────────────────

const EXEC = 'node /data/browser-cli/exec.js';

const PERSONAS = ['careful', 'fast', 'distracted', 'professional'];

const QWERTY_ADJACENT = {
  q:['w','a','s'],       w:['q','e','a','s','d'],   e:['w','r','s','d','f'],
  r:['e','t','d','f','g'],t:['r','y','f','g','h'],  y:['t','u','g','h','j'],
  u:['y','i','h','j','k'],i:['u','o','j','k','l'],  o:['i','p','k','l'],
  p:['o','l'],           a:['q','w','s','z'],         s:['a','w','e','d','x','z'],
  d:['s','e','r','f','c','x'],f:['d','r','t','g','v','c'],g:['f','t','y','h','b','v'],
  h:['g','y','u','j','n','b'],j:['h','u','i','k','m','n'],k:['j','i','o','l','m'],
  l:['k','o','p'],       z:['a','s','x'],              x:['z','s','d','c'],
  c:['x','d','f','v'],   v:['c','f','g','b'],          b:['v','g','h','n'],
  n:['b','h','j','m'],   m:['n','j','k'],
  '1':['2','q'],         '2':['1','3','q','w'],        '3':['2','4','w','e'],
  '4':['3','5','e','r'], '5':['4','6','r','t'],        '6':['5','7','t','y'],
  '7':['6','8','y','u'], '8':['7','9','u','i'],        '9':['8','0','i','o'],
  '0':['9','o','p'],
};

// ── Utilities ─────────────────────────────────────────────────────────────────

function rand(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function randFloat(min, max) {
  return Math.random() * (max - min) + min;
}

function randChoice(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

// Gaussian sample via Box-Muller (clamped to [min, max])
function randGaussian(mean, stdDev, min, max) {
  let u, v, s;
  do {
    u = Math.random() * 2 - 1;
    v = Math.random() * 2 - 1;
    s = u * u + v * v;
  } while (s >= 1 || s === 0);
  const mul = Math.sqrt(-2 * Math.log(s) / s);
  const sample = mean + stdDev * u * mul;
  return Math.max(min, Math.min(max, Math.round(sample)));
}

// ── Sidecar JSONL helpers ─────────────────────────────────────────────────────

function readSidecar(sidecarFile) {
  if (!sidecarFile || !existsSync(sidecarFile)) return [];
  try {
    return readFileSync(sidecarFile, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map(line => { try { return JSON.parse(line); } catch { return null; } })
      .filter(Boolean);
  } catch { return []; }
}

function writeSidecar(sidecarFile, entry) {
  if (!sidecarFile) return;
  try {
    appendFileSync(sidecarFile, JSON.stringify({ ts: Date.now(), ...entry }) + '\n');
  } catch { /* non-fatal */ }
}

// ── Session Profile ───────────────────────────────────────────────────────────
// Generated once per session. Loaded from first sidecar entry on subsequent calls.

function getOrCreateSessionProfile(history, sidecarFile) {
  const existing = history.find(e => e.type === 'session_profile');
  if (existing) return existing;

  const profile = {
    type: 'session_profile',
    baseTypingWpm: rand(40, 60),
    sessionTypoRate: parseFloat(randFloat(0.00, 0.14).toFixed(3)),
    baseMouseSpeed: rand(45, 75),
    sessionPersona: randChoice(PERSONAS),
    // Per-session "reading pause" cadence: after how many actions a long pause is likely
    readingPauseCadence: rand(3, 7),
    // Scroll style: "small" (500-580px), "medium" (540-640px), "large" (600-700px)
    scrollStyle: randChoice(['small', 'medium', 'large']),
  };

  writeSidecar(sidecarFile, profile);
  return profile;
}

// ── Command Classifier ────────────────────────────────────────────────────────

function classifyCommand(rawCommand) {
  const cmd = rawCommand.toLowerCase();
  if (cmd.includes('snapshot')) return 'snapshot';
  if (cmd.includes('screenshot')) return 'screenshot';
  if (cmd.includes(' wait ') || / wait$/.test(cmd)) return 'wait';
  if (cmd.includes('stop')) return 'stop';
  if (cmd.includes('navigate')) return 'navigate';
  if (cmd.includes('scroll')) return 'scroll';
  if (cmd.includes('--kind fill') || cmd.includes('--kind type')) return 'type';
  if (cmd.includes('--kind click')) return 'click';
  if (cmd.includes('--kind check')) return 'check';
  if (cmd.includes('--kind press') || cmd.includes('press-key')) return 'press';
  if (cmd.includes('open-tab') || cmd.includes('switch-tab') || cmd.includes('close-tab')) return 'tab';
  if (cmd.includes('background-breathe')) return 'breathe';
  if (cmd.includes('get-text')) return 'get-text';
  if (cmd.includes('checkpoint')) return 'checkpoint';
  return 'act';
}

// ── Algorithm A: Pre-Action Idle Delay ───────────────────────────────────────

function generateIdleDelay(profile, history, actionType) {
  // No pre-delay for these — they're already internal pauses or meta-ops
  if (['wait', 'stop', 'snapshot', 'screenshot', 'breathe', 'checkpoint'].includes(actionType)) {
    return 0;
  }

  const recentDelays = history
    .filter(e => e.type === 'humanizer_params' && e.preActionDelayMs != null)
    .slice(-5)
    .map(e => e.preActionDelayMs);

  const recentActions = history.filter(e => e.type === 'humanizer_params').slice(-20);

  // Base delay by persona
  let baseMin = 200, baseMax = 1800;
  if (profile.sessionPersona === 'fast') { baseMin = 120; baseMax = 900; }
  if (profile.sessionPersona === 'distracted') { baseMin = 300; baseMax = 2400; }
  if (profile.sessionPersona === 'careful') { baseMin = 400; baseMax = 2000; }

  // 8% chance of a "distraction spike" — user got momentarily distracted
  const distractionTriggered = Math.random() < 0.08;

  // 22% chance of a "reading pause" based on cadence
  const lastLongPause = recentActions.findIndex(e => (e.preActionDelayMs || 0) > 1500);
  const actionsSinceLong = lastLongPause === -1 ? recentActions.length : lastLongPause;
  const readingPauseTriggered = actionsSinceLong >= profile.readingPauseCadence && Math.random() < 0.22;

  let delayMs;
  if (distractionTriggered) {
    delayMs = rand(3000, profile.sessionPersona === 'distracted' ? 7000 : 5000);
  } else if (readingPauseTriggered) {
    delayMs = rand(1500, 5000);
  } else {
    delayMs = rand(baseMin, baseMax);
  }

  // Anti-pattern: ensure not within 100ms of any of the last 5 delays
  let attempts = 0;
  while (attempts < 8) {
    const tooClose = recentDelays.some(d => Math.abs(d - delayMs) < 100);
    if (!tooClose) break;
    delayMs = rand(baseMin, distractionTriggered ? 7000 : readingPauseTriggered ? 5000 : baseMax);
    attempts++;
  }

  // Anti-monotone: check if last 5 are monotonically trending
  if (recentDelays.length >= 5) {
    const diffs = recentDelays.slice(-4).map((d, i) => recentDelays.slice(-4)[i + 1] - d).filter(d => !isNaN(d));
    const allUp = diffs.every(d => d > 0);
    const allDown = diffs.every(d => d < 0);
    if ((allUp && delayMs > recentDelays[recentDelays.length - 1]) ||
        (allDown && delayMs < recentDelays[recentDelays.length - 1])) {
      // Break the trend
      delayMs = allUp
        ? rand(baseMin, Math.min(recentDelays[recentDelays.length - 1] - 150, baseMax))
        : rand(Math.max(recentDelays[recentDelays.length - 1] + 150, baseMin), baseMax);
      delayMs = Math.max(baseMin, Math.min(baseMax, delayMs));
    }
  }

  return delayMs;
}

// ── Algorithm B: Scroll Amount ────────────────────────────────────────────────

function generateScrollAmount(profile, history) {
  const recentScrolls = history
    .filter(e => e.type === 'humanizer_params' && e.scrollPx != null)
    .slice(-10)
    .map(e => e.scrollPx);

  const last3 = recentScrolls.slice(-3);

  // Scroll style determines range bias
  let min = 500, max = 700;
  if (profile.scrollStyle === 'small') { min = 500; max = 600; }
  if (profile.scrollStyle === 'medium') { min = 530; max = 650; }
  if (profile.scrollStyle === 'large') { min = 580; max = 700; }

  let px = rand(min, max);
  let attempts = 0;
  while (attempts < 10) {
    const tooClose = last3.some(s => Math.abs(s - px) < 40);
    if (!tooClose) break;
    px = rand(min, max);
    attempts++;
  }
  return px;
}

// ── Algorithm C: Typing Decisions ─────────────────────────────────────────────

function generateTypingDecisions(profile, history) {
  const recentTypeActions = history
    .filter(e => e.type === 'humanizer_params' && e.action === 'type')
    .slice(-10);

  // WPM for this action: base ± jitter
  const wpmJitter = rand(-8, 8);
  const wpm = Math.max(40, Math.min(60, profile.baseTypingWpm + wpmJitter));

  // Typo decision with streak control
  let typoRate = profile.sessionTypoRate;
  const recentTypos = recentTypeActions.slice(-10).map(e => e.typoDecided);
  const consecutiveTypos = (() => {
    let count = 0;
    for (let i = recentTypos.length - 1; i >= 0; i--) {
      if (recentTypos[i]) count++; else break;
    }
    return count;
  })();
  const consecutiveNoTypos = (() => {
    let count = 0;
    for (let i = recentTypos.length - 1; i >= 0; i--) {
      if (!recentTypos[i]) count++; else break;
    }
    return count;
  })();

  if (consecutiveTypos >= 3) typoRate = 0; // force clean stretch
  else if (consecutiveNoTypos >= 5) typoRate = Math.min(typoRate * 1.5, 0.20); // overdue

  const typoDecided = Math.random() < typoRate;
  const typoType = typoDecided ? randChoice(['adjacent_key', 'transposition', 'double_letter']) : null;
  const cognitiveDelayMs = typoDecided ? rand(500, 2500) : null;

  return { wpm, typoDecided, typoType, cognitiveDelayMs };
}

// ── Algorithm D: Extract element ref from command ─────────────────────────────

function extractRef(rawCommand) {
  const m = rawCommand.match(/--ref\s+(\S+)/);
  return m ? m[1] : null;
}

// ── Algorithm E: Mutate scroll command ────────────────────────────────────────

function mutateScrollCommand(rawCommand, scrollPx) {
  // Replace existing --pixels value, or append if missing
  if (/--pixels\s+\d+/.test(rawCommand)) {
    return rawCommand.replace(/--pixels\s+\d+/, `--pixels ${scrollPx}`);
  }
  return rawCommand + ` --pixels ${scrollPx}`;
}

// ── Main ──────────────────────────────────────────────────────────────────────

const inputRaw = process.argv[2];

if (!inputRaw) {
  process.stderr.write('[humanizer.js] No input JSON provided\n');
  process.exit(1);
}

let input;
try {
  input = JSON.parse(inputRaw);
} catch (e) {
  process.stderr.write(`[humanizer.js] Invalid input JSON: ${e.message}\n`);
  process.exit(1);
}

const { rawCommand, sessionId, sidecarFile } = input;

if (!rawCommand) {
  process.stderr.write('[humanizer.js] rawCommand is required\n');
  process.exit(1);
}

// Load history and session profile
const history = readSidecar(sidecarFile);
const profile = getOrCreateSessionProfile(history, sidecarFile);
const actionType = classifyCommand(rawCommand);

// ── Generate parameters ───────────────────────────────────────────────────────

const idleDelayMs = generateIdleDelay(profile, history, actionType);

const logEntry = {
  action: actionType,
  preActionDelayMs: idleDelayMs,
  rawCommand,
  sessionPersona: profile.sessionPersona,
};

// Build the command sequence
const sequence = [];

// 1. Pre-action idle pause (if > 0)
if (idleDelayMs > 0) {
  sequence.push(`${EXEC} wait ${idleDelayMs}`);
}

// 2. Core command (mutated if scroll)
let coreCommand = rawCommand;
if (actionType === 'scroll') {
  const scrollPx = generateScrollAmount(profile, history);
  coreCommand = mutateScrollCommand(rawCommand, scrollPx);
  logEntry.scrollPx = scrollPx;
}

// Typing decisions (logged for history, for future exec.js flag support)
if (['type', 'press'].includes(actionType)) {
  const typingDecisions = generateTypingDecisions(profile, history);
  Object.assign(logEntry, {
    wpm: typingDecisions.wpm,
    typoDecided: typingDecisions.typoDecided,
    typoType: typingDecisions.typoType,
    cognitiveDelayMs: typingDecisions.cognitiveDelayMs,
  });
}

// Extract element ref for click logging
if (['click', 'check', 'type'].includes(actionType)) {
  const ref = extractRef(rawCommand);
  if (ref) logEntry.ref = ref;
}

sequence.push(coreCommand);

// 3. Always append snapshot UNLESS it's a pure meta-command
const skipSnapshot = ['wait', 'stop', 'screenshot', 'snapshot', 'breathe', 'checkpoint', 'get-text'].includes(actionType);
if (!skipSnapshot) {
  sequence.push(`${EXEC} snapshot`);
}

// ── Output ────────────────────────────────────────────────────────────────────

const result = {
  sequence,
  logEntry: { ...logEntry, ts: Date.now() },
  profile: {
    persona: profile.sessionPersona,
    baseTypingWpm: profile.baseTypingWpm,
    sessionTypoRate: profile.sessionTypoRate,
  },
};

process.stdout.write(JSON.stringify(result) + '\n');
process.exit(0);
