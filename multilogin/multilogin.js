#!/usr/bin/env node
// multilogin.js — MultiLogin X profile manager for the HumanBrowser worker pool.
//
// MultiLogin X agent (mlx) runs locally inside the container.
// Launcher API is at http://127.0.0.1:45001 (launcher.mlx.yt resolves to localhost).
// Cloud API is at https://api.multilogin.com
//
// Configure via env vars:
//   MULTILOGIN_EMAIL           (required)
//   MULTILOGIN_PASSWORD        (required, plaintext — MD5-hashed before sending)
//   MULTILOGIN_FOLDER_ID       (required — UUID of folder for new profiles; get from ML UI)
//   MULTILOGIN_LAUNCHER_HOST   (default: 127.0.0.1)
//   MULTILOGIN_LAUNCHER_PORT   (default: 45001)
//
// Registry: /data/multilogin/open-profiles.json
// Maps profileId → { port, cdpUrl, startedAt }

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { createHash } from 'crypto';

const ML_EMAIL    = process.env.MULTILOGIN_EMAIL    || '';
const ML_PASSWORD = process.env.MULTILOGIN_PASSWORD || '';
const ML_FOLDER_ID = process.env.MULTILOGIN_FOLDER_ID || '';

// launcher.mlx.yt resolves to 127.0.0.1 by default; in our setup it's aliased
// to visual-vps (172.18.0.3) via /etc/hosts + docker-compose extra_hosts.
const ML_LAUNCHER_HOST = process.env.MULTILOGIN_LAUNCHER_HOST || 'launcher.mlx.yt';
const ML_LAUNCHER_PORT = process.env.MULTILOGIN_LAUNCHER_PORT || '45001';
const ML_LAUNCHER_BASE = `https://${ML_LAUNCHER_HOST}:${ML_LAUNCHER_PORT}`;

// MultiLogin runs in openclaw-mrdz-visual-vps-1 (172.18.0.3); CDP port is on that host.
// Override with MULTILOGIN_CDP_HOST env var if needed.
const ML_CDP_HOST = process.env.MULTILOGIN_CDP_HOST || 'openclaw-mrdz-visual-vps-1';

const ML_CLOUD_API = 'https://api.multilogin.com';

// cdp-proxy runs in visual-vps and forwards CDP ports to 0.0.0.0 so openclaw can reach them.
// The proxy listens on port 45050 for management API calls.
// CDP port offset: externalPort = localPort + 10000 (avoids conflict with Chrome's localhost bind).
const CDP_PROXY_PORT = parseInt(process.env.MULTILOGIN_CDP_PROXY_PORT || '45050', 10);
const CDP_PORT_OFFSET = 10000;
// Fixed external port that openclaw's native `browser profile="mimic"` always connects to.
// After starting any profile, we ALSO register it on this port so the director agent
// can use `browser snapshot profile="mimic"` without knowing the dynamic local port.
const FIXED_OPENCLAW_CDP_PORT = 55000;

const REGISTRY_PATH  = '/data/multilogin/open-profiles.json';
const TOKEN_CACHE_PATH = '/data/multilogin/token-cache.json';

mkdirSync('/data/multilogin', { recursive: true });

// ── Registry helpers ─────────────────────────────────────────────────────────

export function readRegistry() {
  try {
    return JSON.parse(readFileSync(REGISTRY_PATH, 'utf8'));
  } catch {
    return {};
  }
}

export function writeRegistry(profileId, port, cdpUrl) {
  const reg = readRegistry();
  reg[profileId] = { port, cdpUrl, startedAt: Date.now() };
  writeFileSync(REGISTRY_PATH, JSON.stringify(reg, null, 2));
}

export function removeFromRegistry(profileId) {
  const reg = readRegistry();
  delete reg[profileId];
  writeFileSync(REGISTRY_PATH, JSON.stringify(reg, null, 2));
}

// ── Token cache ──────────────────────────────────────────────────────────────

let _tokenCache = null; // { token, workspaceId, expiresAt }

function loadTokenCache() {
  if (_tokenCache) return _tokenCache;
  try {
    const data = JSON.parse(readFileSync(TOKEN_CACHE_PATH, 'utf8'));
    if (data && data.token && data.expiresAt > Date.now()) {
      _tokenCache = data;
    }
  } catch {}
  return _tokenCache;
}

function saveTokenCache(token, workspaceId, expiresAt) {
  _tokenCache = { token, workspaceId, expiresAt };
  try {
    writeFileSync(TOKEN_CACHE_PATH, JSON.stringify(_tokenCache, null, 2));
  } catch {}
}

function md5(str) {
  return createHash('md5').update(str).digest('hex');
}

// Fetch (or return cached) auth token. Refreshes when < 5 min remain.
export async function getToken() {
  const cached = loadTokenCache();
  const fiveMin = 5 * 60 * 1000;
  if (cached && cached.expiresAt - Date.now() > fiveMin) {
    return cached;
  }

  if (!ML_EMAIL || !ML_PASSWORD) {
    throw new Error(
      'MULTILOGIN_EMAIL and MULTILOGIN_PASSWORD must be set in .env. ' +
      'Add them to /docker/openclaw-mrdz/.env and restart the container.'
    );
  }

  const res = await fetch(`${ML_CLOUD_API}/user/signin`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email: ML_EMAIL,
      password: md5(ML_PASSWORD),
    }),
    signal: AbortSignal.timeout(30000),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`MultiLogin auth failed HTTP ${res.status}: ${text.slice(0, 300)}`);
  }

  const body = await res.json();
  const token = body?.data?.token;
  const workspaceId = body?.data?.workspace_id;

  if (!token) {
    throw new Error(`MultiLogin auth returned no token. Response: ${JSON.stringify(body).slice(0, 200)}`);
  }

  // Token lasts 30 min; cache for 25 min
  const expiresAt = Date.now() + 25 * 60 * 1000;
  saveTokenCache(token, workspaceId, expiresAt);

  return { token, workspaceId, expiresAt };
}

// ── Launcher API helpers ─────────────────────────────────────────────────────

async function launcherGet(path, token, timeoutMs = 60000) {
  const url = `${ML_LAUNCHER_BASE}${path}`;
  const res = await fetch(url, {
    method: 'GET',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Accept': 'application/json',
    },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`MultiLogin launcher ${path} returned HTTP ${res.status}: ${text.slice(0, 300)}`);
  }
  return res.json();
}

// ── Cloud API helpers ────────────────────────────────────────────────────────

async function cloudGet(path, token, timeoutMs = 30000) {
  const url = `${ML_CLOUD_API}${path}`;
  const res = await fetch(url, {
    method: 'GET',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Accept': 'application/json',
    },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`MultiLogin cloud GET ${path} returned HTTP ${res.status}: ${text.slice(0, 300)}`);
  }
  return res.json();
}

async function cloudPost(path, body, token, timeoutMs = 30000) {
  const url = `${ML_CLOUD_API}${path}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`MultiLogin cloud ${path} returned HTTP ${res.status}: ${text.slice(0, 300)}`);
  }
  return res.json();
}

// ── Profile management ───────────────────────────────────────────────────────

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// Start a MultiLogin X profile. Returns the CDP wsUrl for Playwright.
// folderId defaults to MULTILOGIN_FOLDER_ID env var.
export async function startProfile(profileId, folderId = null) {
  const { token } = await getToken();
  const folder = folderId || ML_FOLDER_ID;

  if (!folder) {
    throw new Error(
      'MULTILOGIN_FOLDER_ID must be set in .env. ' +
      'Get the folder UUID from the MultiLogin X web interface.'
    );
  }

  // Start browser profile via launcher API
  let startData;
  let profileAlreadyRunning = false;
  try {
    startData = await launcherGet(
      `/api/v2/profile/f/${folder}/p/${profileId}/start?automation_type=playwright&headless_mode=false`,
      token,
      120000  // 2 min timeout — browser may need to download on first start
    );
  } catch (e) {
    // Handle PROFILE_ALREADY_RUNNING: browser is open, try to get port from running-profile endpoint
    if (e.message.includes('PROFILE_ALREADY_RUNNING')) {
      profileAlreadyRunning = true;
      process.stderr.write(`[multilogin] Profile ${profileId} already running — fetching running port\n`);
      try {
        startData = await launcherGet(
          `/api/v2/profile/f/${folder}/p/${profileId}/running`,
          token,
          15000
        );
      } catch (e2) {
        // Running endpoint not available — check registry for cached cdpUrl
        const reg = readRegistry();
        const entry = reg[profileId];
        if (entry?.cdpUrl) {
          process.stderr.write(`[multilogin] Using cached cdpUrl from registry for ${profileId}\n`);
          return entry.cdpUrl;
        }
        // Last resort: ask the CDP proxy to find the port by scanning running processes
        process.stderr.write(`[multilogin] /running endpoint unavailable — trying CDP proxy port discovery\n`);
        try {
          const findRes = await fetch(
            `http://${ML_CDP_HOST}:${CDP_PROXY_PORT}/find-port?profile_id=${encodeURIComponent(profileId)}`,
            { signal: AbortSignal.timeout(8000) }
          );
          if (findRes.ok) {
            const findData = await findRes.json();
            const discoveredPort = findData.port;
            if (discoveredPort) {
              process.stderr.write(`[multilogin] CDP proxy discovered port ${discoveredPort} for profile ${profileId}\n`);
              // Register CDP proxy forwards for this discovered port
              const externalCdpPort = discoveredPort + CDP_PORT_OFFSET;
              for (const extPort of [externalCdpPort, FIXED_OPENCLAW_CDP_PORT]) {
                await fetch(`http://${ML_CDP_HOST}:${CDP_PROXY_PORT}/forward`, {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ localPort: discoveredPort, externalPort: extPort }),
                  signal: AbortSignal.timeout(8000),
                }).catch(() => {});
              }
              await sleep(1000);
              // Fetch CDP wsUrl
              const versionUrl = `http://${ML_CDP_HOST}:${externalCdpPort}/json/version`;
              const versionRes = await fetch(versionUrl, { signal: AbortSignal.timeout(8000) });
              if (versionRes.ok) {
                const versionData = await versionRes.json();
                let cdpUrl = versionData.webSocketDebuggerUrl;
                if (cdpUrl) {
                  cdpUrl = cdpUrl.replace(/127\.0\.0\.1:\d+/, `${ML_CDP_HOST}:${externalCdpPort}`);
                  cdpUrl = cdpUrl.replace(/127\.0\.0\.1/, ML_CDP_HOST);
                  writeRegistry(profileId, discoveredPort, cdpUrl);
                  process.stderr.write(`[multilogin] Profile ${profileId} CDP (discovered): ${cdpUrl}\n`);
                  return cdpUrl;
                }
              }
            }
          }
        } catch (e3) {
          process.stderr.write(`[multilogin] CDP proxy port discovery failed: ${e3.message}\n`);
        }
        throw new Error(
          `Profile ${profileId} is already running but cannot get its port. ` +
          `Try stopping it first: openclaw or MultiLogin X dashboard. ` +
          `Original error: ${e.message}`
        );
      }
    } else {
      throw new Error(
        `Cannot reach MultiLogin X launcher at ${ML_LAUNCHER_BASE}. ` +
        `Is the mlx agent running? Run: bash /data/setup-human-browser.sh ` +
        `Original error: ${e.message}`
      );
    }
  }

  const port = parseInt(startData?.data?.port || startData?.port || '0', 10);
  if (!port) {
    throw new Error(`MultiLogin X launcher returned no port for profile ${profileId}: ${JSON.stringify(startData)}`);
  }

  process.stderr.write(`[multilogin] Profile ${profileId} started on local port ${port}, waiting for browser...\n`);

  // Wait for browser to fully initialize (increased from 2s to 5s for stability)
  await sleep(5000);

  // Set up cross-container CDP forwarding via cdp-proxy running in visual-vps.
  // Mimic binds CDP to 127.0.0.1:PORT — not reachable cross-container.
  // Register on two external ports:
  //   1. port + CDP_PORT_OFFSET  — for the worker pool (dispatch.js/worker.js)
  //   2. FIXED_OPENCLAW_CDP_PORT — stable alias for openclaw native browser tool
  const externalCdpPort = port + CDP_PORT_OFFSET;
  for (const extPort of [externalCdpPort, FIXED_OPENCLAW_CDP_PORT]) {
    try {
      const proxyRes = await fetch(`http://${ML_CDP_HOST}:${CDP_PROXY_PORT}/forward`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ localPort: port, externalPort: extPort }),
        signal: AbortSignal.timeout(8000),
      });
      const proxyBody = await proxyRes.json();
      process.stderr.write(`[multilogin] cdp-proxy port ${extPort}: ${JSON.stringify(proxyBody)}\n`);
    } catch (e) {
      process.stderr.write(`[multilogin] WARNING: cdp-proxy setup failed for port ${extPort} (${e.message})\n`);
    }
  }

  // Fetch CDP endpoint — retry up to 6 times (18s total) so slow-starting browsers succeed
  let cdpUrl;
  const versionUrl = `http://${ML_CDP_HOST}:${externalCdpPort}/json/version`;
  for (let attempt = 1; attempt <= 6; attempt++) {
    try {
      const versionRes = await fetch(versionUrl, { signal: AbortSignal.timeout(5000) });
      if (!versionRes.ok) throw new Error(`HTTP ${versionRes.status}`);
      const versionData = await versionRes.json();
      cdpUrl = versionData.webSocketDebuggerUrl;
      if (!cdpUrl) throw new Error('webSocketDebuggerUrl not present');
      // Rewrite host to use external CDP proxy address
      cdpUrl = cdpUrl.replace(/127\.0\.0\.1:\d+/, `${ML_CDP_HOST}:${externalCdpPort}`);
      cdpUrl = cdpUrl.replace(/127\.0\.0\.1/, ML_CDP_HOST);
      process.stderr.write(`[multilogin] /json/version OK on attempt ${attempt}: ${cdpUrl}\n`);
      break;
    } catch (e) {
      process.stderr.write(`[multilogin] /json/version attempt ${attempt}/6 failed: ${e.message}\n`);
      if (attempt < 6) await sleep(3000);
      else {
        process.stderr.write(`[multilogin] All /json/version attempts failed — using HTTP fallback\n`);
        cdpUrl = `http://${ML_CDP_HOST}:${externalCdpPort}`;
      }
    }
  }

  writeRegistry(profileId, port, cdpUrl);
  process.stderr.write(`[multilogin] Profile ${profileId} CDP: ${cdpUrl}\n`);
  return cdpUrl;
}

// Stop a MultiLogin X profile and remove it from the registry.
export async function stopProfile(profileId) {
  // Remove cdp-proxy forwarding first (if we know the port)
  const reg = readRegistry();
  const entry = reg[profileId];
  if (entry?.port) {
    const externalPort = entry.port + CDP_PORT_OFFSET;
    for (const extPort of [externalPort, FIXED_OPENCLAW_CDP_PORT]) {
      fetch(`http://${ML_CDP_HOST}:${CDP_PROXY_PORT}/forward/${extPort}`, {
        method: 'DELETE',
        signal: AbortSignal.timeout(5000),
      }).catch(() => {});
    }
  }

  try {
    const { token } = await getToken();
    await launcherGet(
      `/api/v1/profile/stop?profile_id=${profileId}`,
      token,
      30000
    );
  } catch (e) {
    // Non-fatal — profile may already be stopped
    process.stderr.write(`[multilogin] Warning: stop profile ${profileId} failed: ${e.message}\n`);
  }
  removeFromRegistry(profileId);
}

// Create a new MultiLogin X browser profile.
// Returns { profileId, folderId }.
export async function createProfile(clientId, platform, clientName, proxy = null) {
  const { token } = await getToken();
  const folder = ML_FOLDER_ID;

  if (!folder) {
    throw new Error(
      'MULTILOGIN_FOLDER_ID must be set in .env. ' +
      'Get the folder UUID from the MultiLogin X web interface and add it to .env.'
    );
  }

  const profileName = `${clientName} | ${platform} | ${clientId}`;

  // Extra Chrome flags needed to prevent SIGTRAP/renderer crashes in containerized environments.
  // These are passed to Mimic (Chromium-based) via the profile's launch_args field.
  const CONTAINER_CHROME_FLAGS = [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-dev-shm-usage',
    '--disable-gpu-sandbox',
    '--disable-gpu',
    '--disable-software-rasterizer',
    '--no-zygote',
  ];

  const body = {
    name: profileName,
    notes: clientId,        // stored in profile notes so findProfileByAccountId() can auto-discover it
    folder_id: folder,
    browser_type: 'mimic',
    os_type: 'macos',
    parameters: {
      storage: {
        is_local: true,
      },
      flags: {
        audio_masking: 'mask',
        fonts_masking: 'mask',
        geolocation_masking: 'mask',
        graphics_masking: 'mask',
        localization_masking: 'mask',
        media_devices_masking: 'mask',
        navigator_masking: 'mask',
        ports_masking: 'mask',
        proxy_masking: 'disabled',
        screen_masking: 'mask',
        timezone_masking: 'mask',
        webrtc_masking: 'mask',
      },
      fingerprint: {
        screen: { resolution: '1440_900' },
      },
      // Container-specific Chrome launch args to prevent SIGTRAP sandbox crashes
      launch_args: CONTAINER_CHROME_FLAGS,
      chrome: {
        extra_flags: CONTAINER_CHROME_FLAGS,
      },
    },
  };

  if (proxy && proxy.host) {
    body.parameters.proxy = {
      type: proxy.type === 'socks5' ? 'socks5' : 'http',
      host: proxy.host,
      port: proxy.port,
      username: proxy.login || '',
      password: proxy.password || '',
    };
  }

  process.stderr.write(`[multilogin] Creating profile "${profileName}" in folder ${folder}...\n`);

  const data = await cloudPost('/profile/create', body, token);

  // API returns { data: { ids: ["uuid"] } } or { data: { id: "uuid" } }
  const profileId =
    data?.data?.id ||
    (Array.isArray(data?.data?.ids) ? data.data.ids[0] : null);

  if (!profileId) {
    throw new Error(`MultiLogin profile create returned no ID. Response: ${JSON.stringify(data).slice(0, 300)}`);
  }

  process.stderr.write(`[multilogin] Profile created: ${profileId}\n`);
  return { profileId, folderId: folder };
}

// ── Proxy creation ───────────────────────────────────────────────────────────

const ML_PROXY_API = 'https://profile-proxy.multilogin.com';

// Named proxy template configurations.
// "LinkedIn Profile Proxy Configuration" — sticky US residential HTTP proxy.
const PROXY_TEMPLATES = {
  linkedin: { sessionType: 'sticky', protocol: 'http', country: 'us', IPTTL: 86400 },
};
const DEFAULT_PROXY_TEMPLATE = { sessionType: 'sticky', protocol: 'http', country: 'us', IPTTL: 86400 };

// Create a proxy for a client using the platform's named template.
// For LinkedIn: always uses "LinkedIn Profile Proxy Configuration" template settings.
// Returns { type, host, port, login, password, connectionUrl }.
export async function createProxy(clientId, platform, clientName) {
  const { token } = await getToken();
  const template = PROXY_TEMPLATES[platform.toLowerCase()] || DEFAULT_PROXY_TEMPLATE;
  const templateName = platform.toLowerCase() === 'linkedin'
    ? 'LinkedIn Profile Proxy Configuration'
    : `${platform} Profile Proxy Configuration`;

  process.stderr.write(`[multilogin] Creating proxy for "${clientName}" (${platform}) using "${templateName}" template...\n`);

  const res = await fetch(`${ML_PROXY_API}/v1/proxy/connection_url`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    },
    body: JSON.stringify(template),
    signal: AbortSignal.timeout(30000),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`MLX proxy generation failed HTTP ${res.status}: ${text.slice(0, 300)}`);
  }

  const data = await res.json();
  const connectionUrl = data?.data;

  if (!connectionUrl || typeof connectionUrl !== 'string') {
    throw new Error(`MLX proxy generation returned no connection URL. Response: ${JSON.stringify(data).slice(0, 200)}`);
  }

  // Parse "host:port:username:password" — password may itself contain colons
  const colonIdx1 = connectionUrl.indexOf(':');
  const colonIdx2 = connectionUrl.indexOf(':', colonIdx1 + 1);
  const colonIdx3 = connectionUrl.indexOf(':', colonIdx2 + 1);
  if (colonIdx1 < 0 || colonIdx2 < 0 || colonIdx3 < 0) {
    throw new Error(`Unexpected proxy connection URL format: ${connectionUrl.slice(0, 100)}`);
  }

  const host     = connectionUrl.slice(0, colonIdx1);
  const port     = parseInt(connectionUrl.slice(colonIdx1 + 1, colonIdx2), 10);
  const login    = connectionUrl.slice(colonIdx2 + 1, colonIdx3);
  const password = connectionUrl.slice(colonIdx3 + 1);

  process.stderr.write(`[multilogin] Proxy created: ${host}:${port} for ${clientId}\n`);

  return {
    type: template.protocol === 'socks5' ? 'socks5' : 'http',
    host,
    port,
    login,
    password,
    connectionUrl,
  };
}

// ── Profile listing ───────────────────────────────────────────────────────────

// List all profiles in a folder from the MLX Cloud API.
// Returns an array of profile objects (each has at least { id, name, notes, folder_id }).
export async function listProfiles(folderId = null) {
  const { token } = await getToken();
  const folder = folderId || ML_FOLDER_ID;
  if (!folder) {
    throw new Error('MULTILOGIN_FOLDER_ID must be set to list profiles');
  }

  let data;
  try {
    // Primary: GET /profile?folder_id=...
    data = await cloudGet(`/profile?folder_id=${encodeURIComponent(folder)}`, token);
  } catch (e) {
    process.stderr.write(`[multilogin] listProfiles GET failed (${e.message}), trying POST /profile/search\n`);
    // Fallback: POST /profile/search (older MLX API versions)
    data = await cloudPost('/profile/search', { folder_id: folder, search_text: '' }, token);
  }

  // Normalize — different API versions return different shapes:
  //   { data: [...] }              (GET /profile, newer API)
  //   { data: { profiles: [...] } } (POST /profile/search, some versions)
  //   { profiles: [...] }          (POST /profile/search, older versions)
  //   [...]                        (bare array)
  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.data)) return data.data;
  if (Array.isArray(data?.data?.profiles)) return data.data.profiles;
  if (Array.isArray(data?.profiles)) return data.profiles;
  return [];
}

// Find a profile by its display name (case-insensitive).
// Returns the profile object (with at least { id, folder_id, name }) or null.
export async function findProfileByName(name, folderId = null) {
  const profiles = await listProfiles(folderId);
  const list = Array.isArray(profiles) ? profiles : [];
  const match = list.find(p => (p.name || '').toLowerCase() === name.toLowerCase());
  if (match) {
    process.stderr.write(`[multilogin] findProfileByName(${name}): found profile ${match.id || match.profile_id}\n`);
  }
  return match || null;
}

// Find a profile whose notes field contains the given accountId.
// Returns the profile object (with at least { id, folder_id, notes }) or null.
export async function findProfileByAccountId(accountId, folderId = null) {
  const profiles = await listProfiles(folderId);
  const match = profiles.find(p => {
    const notes = (p.notes || p.custom_info || '').trim();
    return notes === accountId || notes.split(/[\s,;|]+/).includes(accountId);
  });
  if (match) {
    process.stderr.write(`[multilogin] findProfileByAccountId(${accountId}): found profile ${match.id || match.profile_id} ("${match.name}")\n`);
  }
  return match || null;
}
