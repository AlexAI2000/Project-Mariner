#!/usr/bin/env node
// generate-password.js — Generate a secure, human-friendly password for new accounts.
//
// Usage: node /data/accounts/generate-password.js [--length 16]
// Output: JSON { password }
//
// Password format: mixed case, numbers, symbols — meets most site requirements.
// Avoids visually ambiguous chars (0/O, 1/l/I).

const length = parseInt(process.argv[process.argv.indexOf('--length') + 1] || '16', 10);

const upper   = 'ABCDEFGHJKMNPQRSTUVWXYZ';
const lower   = 'abcdefghjkmnpqrstuvwxyz';
const digits  = '23456789';
const symbols = '!@#$%^&*';
const all     = upper + lower + digits + symbols;

function pick(set) { return set[Math.floor(Math.random() * set.length)]; }

// Guarantee at least one of each required category
let chars = [pick(upper), pick(lower), pick(digits), pick(symbols)];
while (chars.length < length) chars.push(pick(all));

// Shuffle
for (let i = chars.length - 1; i > 0; i--) {
  const j = Math.floor(Math.random() * (i + 1));
  [chars[i], chars[j]] = [chars[j], chars[i]];
}

console.log(JSON.stringify({ password: chars.join('') }));
