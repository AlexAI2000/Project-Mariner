#!/usr/bin/env node
// update-profiles-macos.mjs
// One-shot: update ALL profiles in the MLX folder to macOS + 1440x900 screen.
// Run once from inside the openclaw container or host with node env vars set.
//
// Usage: node /data/multilogin/update-profiles-macos.mjs

import { getToken, listProfiles } from './multilogin.js';

const ML_CLOUD_API = 'https://api.multilogin.com';

async function updateProfile(profileId, token) {
  // Try PUT /profile/{id} first (MLX v2 API)
  const body = {
    os_type: 'macos',
    parameters: {
      fingerprint: {
        screen: { resolution: '1440_900' },
      },
    },
  };

  let res = await fetch(`${ML_CLOUD_API}/profile/${profileId}`, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20000),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    // Fallback: PATCH
    if (res.status === 405 || res.status === 404) {
      res = await fetch(`${ML_CLOUD_API}/profile/${profileId}`, {
        method: 'PATCH',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(20000),
      });
      if (!res.ok) {
        const t2 = await res.text().catch(() => '');
        return { ok: false, error: `PATCH ${res.status}: ${t2.slice(0, 200)}` };
      }
    } else {
      return { ok: false, error: `PUT ${res.status}: ${text.slice(0, 200)}` };
    }
  }

  const data = await res.json().catch(() => ({}));
  return { ok: true, data };
}

async function main() {
  console.log('Authenticating with MultiLogin X...');
  const { token } = await getToken();
  console.log('Auth OK.');

  console.log('Listing profiles in folder...');
  const profiles = await listProfiles();
  console.log(`Found ${profiles.length} profile(s).`);

  for (const p of profiles) {
    const id   = p.id || p.profile_id;
    const name = p.name || id;
    process.stdout.write(`  Updating "${name}" (${id})... `);
    const result = await updateProfile(id, token);
    if (result.ok) {
      console.log('OK');
    } else {
      console.log(`FAILED: ${result.error}`);
    }
  }

  console.log('\nDone. Profiles updated to macOS / 1440x900.');
  console.log('Restart any open browser sessions to pick up the new fingerprint.');
}

main().catch(e => { console.error('Fatal:', e.message); process.exit(1); });
