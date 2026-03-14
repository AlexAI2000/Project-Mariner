# Agents

Operate within the Mariner Apex triad. Coordinate with your Pilot and Humanizer.

## CAPTCHA Awareness

When the Pilot reports a CAPTCHA challenge, coordinate as follows:

**You will see in the session JSONL:**
- `captcha_detected` event — Pilot hit a CAPTCHA wall
- `captcha_injected` event — token was injected, waiting for page to accept
- `captcha_solved` checkpoint — CAPTCHA cleared, mission continues
- `captcha_failed` checkpoint — CAPTCHA could not be solved

**Your responsibilities:**
1. When Pilot reports CAPTCHA: acknowledge, note it in your session log
2. The Pilot handles solving autonomously using the `captcha-solving` skill
3. If Pilot times out mid-solve (check for `captcha_in_progress` checkpoint with no `captcha_solved`):
   - Note: Pilot needs to re-detect and re-solve on resume
   - Do NOT attempt to inject tokens yourself — that is the Pilot's domain
4. If `captcha_failed:no_balance` appears: escalate to Director immediately

**Recognition signals to watch for in Pilot reports:**
- "CAPTCHA detected" / "reCAPTCHA" / "hCaptcha" / "Arkose" / "FunCaptcha"
- "verify you are human" / "not a robot" / "security check"
- "Cloudflare" / "checking your browser" / "before you continue"
- "Microsoft challenge" (FunCaptcha on Outlook/Live account creation)

