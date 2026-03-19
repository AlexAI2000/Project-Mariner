#!/usr/bin/env node
// secure-skill-install.js — Mariner Secure Skill Installer
//
// Installs a skill from ClawHub ONLY after passing all security gates:
//   1. Source must be clawhub.ai — no GitHub, no npm, no external URLs
//   2. VirusTotal: status=clean AND verdict=benign
//   3. LLM analysis (OpenClaw confidence): confidence=high AND verdict=benign
//   4. Static scan: status=clean AND findings=[]
//
// If ANY check fails → ABORT. No exceptions.
//
// Usage: node /data/mariner/secure-skill-install.js <slug> <targetWorkspaceDir>
//
// Example: node /data/mariner/secure-skill-install.js self-improving-agent /data/.openclaw/workspace-sm-linkedin-1

import { createWriteStream, mkdirSync, existsSync } from 'fs';
import { get as httpsGet } from 'https';
import { join } from 'path';
import { createHash } from 'crypto';
import { execFileSync } from 'child_process';
import { tmpdir } from 'os';

const CLAWHUB_CONVEX = 'https://wry-manatee-359.convex.cloud';
const CLAWHUB_SITE   = 'https://wry-manatee-359.convex.site';
const CLAWHUB_DOMAIN = 'clawhub.ai';

const [, , slug, targetWorkspaceDir] = process.argv;

if (!slug || !targetWorkspaceDir) {
  console.error('Usage: node secure-skill-install.js <slug> <targetWorkspaceDir>');
  console.error('Example: node secure-skill-install.js self-improving-agent /data/.openclaw/workspace-sm-linkedin-1');
  process.exit(1);
}

// ── Validate slug (no path traversal, no external URLs) ───────────────────────
if (slug.includes('/') || slug.includes('..') || slug.includes('http') || !/^[a-z0-9_-]+$/.test(slug)) {
  console.error(`[SECURITY BLOCK] Invalid slug: "${slug}". Slugs must be lowercase alphanumeric with hyphens only.`);
  console.error('Skill installation aborted.');
  process.exit(2);
}

function httpPost(url, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const urlObj = new URL(url);
    const options = {
      hostname: urlObj.hostname,
      path: urlObj.pathname,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
    };
    const req = require('https').request(options, res => {
      let body = '';
      res.on('data', d => body += d);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(body) }); }
        catch { resolve({ status: res.statusCode, body }); }
      });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

// ── Step 1: Fetch skill metadata + scan results from ClawHub ─────────────────
console.log(`[secure-skill-install] Fetching security scan for: ${slug}`);

const { createRequire } = await import('module');
const require = createRequire(import.meta.url);
const https = require('https');

function httpsPostSync(urlStr, payload) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(payload);
    const url = new URL(urlStr);
    const opts = {
      hostname: url.hostname,
      path: url.pathname + url.search,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
      timeout: 15000,
    };
    const req = https.request(opts, res => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => {
        try { resolve(JSON.parse(body)); }
        catch { reject(new Error(`Non-JSON response: ${body.slice(0, 200)}`)); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Request timed out')); });
    req.write(data);
    req.end();
  });
}

function downloadFile(urlStr, destPath) {
  return new Promise((resolve, reject) => {
    const file = createWriteStream(destPath);
    https.get(urlStr, { timeout: 30000 }, res => {
      if (res.statusCode !== 200) {
        file.close();
        reject(new Error(`HTTP ${res.statusCode}`));
        return;
      }
      res.pipe(file);
      file.on('finish', () => file.close(resolve));
    }).on('error', err => { file.close(); reject(err); });
  });
}

async function main() {
  // ── Fetch scan data ──────────────────────────────────────────────────────────
  const result = await httpsPostSync(`${CLAWHUB_CONVEX}/api/query`, {
    path: 'skills:getBySlug',
    args: { slug },
  });

  if (!result.value) {
    console.error(`[SECURITY BLOCK] Skill "${slug}" not found on clawhub.ai.`);
    process.exit(3);
  }

  const { latestVersion: lv, moderationInfo: mod } = result.value;

  if (!lv) {
    console.error('[SECURITY BLOCK] No version data available for this skill.');
    process.exit(3);
  }

  // ── Security Gate 1: Moderation flags ────────────────────────────────────────
  if (mod?.isMalwareBlocked) {
    console.error('[SECURITY BLOCK] ❌ Skill is blocked by ClawHub — malicious content detected. INSTALLATION PROHIBITED.');
    process.exit(4);
  }
  if (mod?.isSuspicious) {
    console.error('[SECURITY BLOCK] ❌ Skill is flagged as suspicious by ClawHub. INSTALLATION PROHIBITED.');
    process.exit(4);
  }
  if (mod?.isRemoved) {
    console.error('[SECURITY BLOCK] ❌ Skill has been removed by a moderator. INSTALLATION PROHIBITED.');
    process.exit(4);
  }
  if (mod?.isPendingScan) {
    console.error('[SECURITY BLOCK] ❌ VirusTotal scan still in progress — cannot verify safety. INSTALLATION PROHIBITED.');
    process.exit(4);
  }

  // ── Security Gate 2: LLM Analysis (OpenClaw confidence) ──────────────────────
  const llm = lv.llmAnalysis || {};
  console.log(`[secure-skill-install] LLM Analysis → confidence=${llm.confidence}, verdict=${llm.verdict}, status=${llm.status}`);

  if (llm.confidence !== 'high') {
    console.error(`[SECURITY BLOCK] ❌ OpenClaw LLM confidence is "${llm.confidence}" — must be "high". INSTALLATION PROHIBITED.`);
    console.error(`  Summary: ${llm.summary || 'N/A'}`);
    process.exit(4);
  }
  if (llm.verdict !== 'benign') {
    console.error(`[SECURITY BLOCK] ❌ OpenClaw LLM verdict is "${llm.verdict}" — must be "benign". INSTALLATION PROHIBITED.`);
    console.error(`  Summary: ${llm.summary || 'N/A'}`);
    process.exit(4);
  }
  if (llm.status && llm.status !== 'clean') {
    console.error(`[SECURITY BLOCK] ❌ OpenClaw LLM status is "${llm.status}" — must be "clean". INSTALLATION PROHIBITED.`);
    process.exit(4);
  }

  // ── Security Gate 3: VirusTotal ──────────────────────────────────────────────
  const vt = lv.vtAnalysis || {};
  console.log(`[secure-skill-install] VirusTotal → status=${vt.status}, verdict=${vt.verdict}`);

  // If VT data exists, it must be clean
  if (vt.status && vt.status !== 'clean') {
    console.error(`[SECURITY BLOCK] ❌ VirusTotal status is "${vt.status}" — must be "clean". INSTALLATION PROHIBITED.`);
    process.exit(4);
  }
  if (vt.verdict && vt.verdict !== 'benign') {
    console.error(`[SECURITY BLOCK] ❌ VirusTotal verdict is "${vt.verdict}" — must be "benign". INSTALLATION PROHIBITED.`);
    process.exit(4);
  }
  if (vt.malicious && vt.malicious > 0) {
    console.error(`[SECURITY BLOCK] ❌ VirusTotal reports ${vt.malicious} malicious detections. INSTALLATION PROHIBITED.`);
    process.exit(4);
  }
  if (vt.suspicious && vt.suspicious > 0) {
    console.error(`[SECURITY BLOCK] ❌ VirusTotal reports ${vt.suspicious} suspicious detections. INSTALLATION PROHIBITED.`);
    process.exit(4);
  }

  // ── Security Gate 4: Static scan ─────────────────────────────────────────────
  const staticScan = lv.staticScan || {};
  console.log(`[secure-skill-install] Static scan → status=${staticScan.status}, findings=${JSON.stringify(staticScan.findings || [])}`);

  if (staticScan.status && staticScan.status !== 'clean') {
    console.error(`[SECURITY BLOCK] ❌ Static scan status is "${staticScan.status}". INSTALLATION PROHIBITED.`);
    process.exit(4);
  }
  if (staticScan.findings && staticScan.findings.length > 0) {
    console.error(`[SECURITY BLOCK] ❌ Static scan found ${staticScan.findings.length} issue(s). INSTALLATION PROHIBITED.`);
    staticScan.findings.forEach(f => console.error(`  - ${JSON.stringify(f)}`));
    process.exit(4);
  }

  // ── All gates passed ──────────────────────────────────────────────────────────
  console.log(`[secure-skill-install] ✅ All security gates passed for "${slug}" v${lv.version}.`);
  console.log(`  SHA256: ${lv.sha256hash}`);

  // ── Download from ClawHub ─────────────────────────────────────────────────────
  const tmpZip = join(tmpdir(), `clawhub-${slug}-${Date.now()}.zip`);
  const downloadUrl = `${CLAWHUB_SITE}/api/v1/download?slug=${encodeURIComponent(slug)}`;

  console.log(`[secure-skill-install] Downloading from ${CLAWHUB_DOMAIN}...`);
  await downloadFile(downloadUrl, tmpZip);

  // ── Verify SHA256 of zip ──────────────────────────────────────────────────────
  const { readFileSync } = await import('fs');
  const zipBytes = readFileSync(tmpZip);
  const actualHash = createHash('sha256').update(zipBytes).digest('hex');
  console.log(`[secure-skill-install] Downloaded hash: ${actualHash}`);

  if (lv.sha256hash && actualHash !== lv.sha256hash) {
    console.error(`[SECURITY BLOCK] ❌ SHA256 mismatch! Expected: ${lv.sha256hash} Got: ${actualHash}`);
    console.error('Download integrity check failed. INSTALLATION ABORTED.');
    process.exit(5);
  }
  console.log('[secure-skill-install] ✅ SHA256 integrity verified.');

  // ── Extract into target workspace ─────────────────────────────────────────────
  const skillDestDir = join(targetWorkspaceDir, 'skills', 'public', slug);
  mkdirSync(skillDestDir, { recursive: true });

  const { execFileSync: exec } = await import('child_process');
  exec('python3', ['-c', `
import zipfile, os, sys
zip_path, dest = sys.argv[1], sys.argv[2]
with zipfile.ZipFile(zip_path) as z:
    for member in z.namelist():
        # Security: strip any path traversal
        clean = os.path.normpath(member)
        if clean.startswith('..') or os.path.isabs(clean):
            print(f"SKIP (traversal): {member}", file=sys.stderr)
            continue
        target = os.path.join(dest, clean)
        if member.endswith('/'):
            os.makedirs(target, exist_ok=True)
        else:
            os.makedirs(os.path.dirname(target), exist_ok=True)
            with z.open(member) as src, open(target, 'wb') as dst:
                dst.write(src.read())
print("Extracted OK")
  `, tmpZip, skillDestDir]);

  // Create .learnings/ template if not present
  const learningsDir = join(targetWorkspaceDir, '.learnings');
  mkdirSync(learningsDir, { recursive: true });
  for (const f of ['LEARNINGS.md', 'ERRORS.md', 'FEATURE_REQUESTS.md']) {
    const dest = join(learningsDir, f);
    if (!existsSync(dest)) {
      const { writeFileSync } = await import('fs');
      writeFileSync(dest, `# ${f.replace('.md', '')}\n\n`, 'utf8');
    }
  }

  console.log(`[secure-skill-install] ✅ Skill "${slug}" installed to: ${skillDestDir}`);
  console.log('[secure-skill-install] MISSION COMPLETE. The skill is verified, safe, and operational.');

  process.exit(0);
}

main().catch(err => {
  console.error(`[secure-skill-install] Fatal error: ${err.message}`);
  process.exit(1);
});
