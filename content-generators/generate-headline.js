#!/usr/bin/env node
// generate-headline.js — Generates a professional LinkedIn headline using Qwen via OpenRouter.
// Usage: node generate-headline.js '<briefing-json>'
// Output: {"headline": "..."} to stdout
// Exit 0: success  Exit 1: error

import { callLLM } from './lib/llm.js';

const SYSTEM_PROMPT = `You are a world-class LinkedIn headline copywriter with 15 years of experience helping executives, entrepreneurs, and professionals stand out. You craft powerful, keyword-rich headlines that attract the exact right audience.

RULES:
- Maximum 220 characters (count carefully)
- Use | to separate 2-3 distinct value propositions
- Lead with the person's primary professional identity/role
- Include 1-2 high-value industry keywords for search visibility
- Be SPECIFIC, never generic ("Marketing Expert" is weak; "B2B SaaS CMO | $50M ARR Growth | ex-HubSpot" is strong)
- Do NOT write "I am..." — write it as a professional identity statement
- Do NOT use buzzwords like "passionate", "guru", "rockstar", "ninja"
- If achievements include numbers, weave one into the headline

Return ONLY valid JSON, no explanation: {"headline": "..."}`;

function buildUserPrompt(b) {
  const achievements = Array.isArray(b.achievements) ? b.achievements.join(', ') : (b.achievements || 'Not specified');
  return `Name: ${b.name || 'Not provided'}
Current role: ${b.jobTitle || 'Not provided'}${b.company ? ` at ${b.company}` : ''}
Industry: ${b.industry || 'Not provided'}
Years of experience: ${b.yearsExperience || 'Not provided'}
Key focus / strengths: ${b.oneLineSummary || b.background || 'Not provided'}
Notable achievements: ${achievements}
Target audience (who should discover them): ${b.targetAudience || 'Not provided'}
Platform: ${b.platform || 'LinkedIn'}

Write the most compelling, specific, and searchable professional headline for this person.`;
}

const input = process.argv[2];
if (!input) {
  console.error('Usage: node generate-headline.js \'{"name":"...","jobTitle":"..."}\'');
  process.exit(1);
}

let briefing;
try {
  briefing = JSON.parse(input);
} catch (e) {
  console.error('Invalid JSON briefing:', e.message);
  process.exit(1);
}

try {
  const result = await callLLM(SYSTEM_PROMPT, buildUserPrompt(briefing));
  if (!result.headline) throw new Error('Response missing "headline" field');
  console.log(JSON.stringify(result));
} catch (e) {
  console.error('generate-headline failed:', e.message);
  process.exit(1);
}
