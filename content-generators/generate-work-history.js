#!/usr/bin/env node
// generate-work-history.js — Generates LinkedIn work experience descriptions using Qwen via OpenRouter.
// Usage: node generate-work-history.js '<briefing-json>'
// Output: {"workHistory": [...]} to stdout
// The briefing must include a workHistory array with company, role, startYear, endYear.
// Exit 0: success  Exit 1: error

import { callLLM } from './lib/llm.js';

const SYSTEM_PROMPT = `You are a professional resume writer and LinkedIn expert specializing in work experience sections. You write achievement-focused role descriptions that impress recruiters, pass ATS systems, and tell a compelling career story.

RULES:
- For EACH role provided: write 3-5 bullet points
- Start each bullet with a strong action verb (Led, Built, Grew, Launched, Reduced, Increased, Managed, Designed, Implemented, Transformed)
- Quantify achievements wherever possible (percentages, dollar amounts, team sizes, time saved, units)
- Use PAST TENSE for all previous roles (even if no end date provided, assume past unless it's the most recent)
- Use PRESENT TENSE only for the most recent role with endYear: null
- Keep each bullet under 200 characters
- Focus on IMPACT, not tasks ("Grew pipeline 3x" not "Was responsible for pipeline growth")
- If specific numbers aren't provided, use realistic estimates appropriate to the company size and role level

Return ONLY valid JSON, no explanation:
{"workHistory": [{"company": "...", "role": "...", "startYear": N, "endYear": N or null, "description": "• Bullet one\\n• Bullet two\\n• Bullet three"}]}`;

function buildUserPrompt(b) {
  const wh = Array.isArray(b.workHistory) && b.workHistory.length > 0
    ? b.workHistory.map(w =>
        `- ${w.role} at ${w.company} (${w.startYear}–${w.endYear || 'present'})` +
        (w.notes ? `: ${w.notes}` : '')
      ).join('\n')
    : 'No work history provided — infer reasonable roles based on their summary and industry.';

  const achievements = Array.isArray(b.achievements)
    ? b.achievements.join('\n- ')
    : (b.achievements || 'Not specified');

  return `Name: ${b.name || 'Not provided'}
Industry: ${b.industry || 'Not provided'}
Summary: ${b.oneLineSummary || b.background || 'Not provided'}
Notable achievements (use these to enrich the descriptions):
- ${achievements}

Work history to write descriptions for:
${wh}

Write compelling, achievement-focused descriptions for each role listed above.`;
}

const input = process.argv[2];
if (!input) {
  console.error('Usage: node generate-work-history.js \'{"workHistory":[...],"name":"..."}\'');
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
  const result = await callLLM(SYSTEM_PROMPT, buildUserPrompt(briefing), 1500);
  if (!result.workHistory) throw new Error('Response missing "workHistory" field');
  console.log(JSON.stringify(result));
} catch (e) {
  console.error('generate-work-history failed:', e.message);
  process.exit(1);
}
