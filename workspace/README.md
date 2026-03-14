# Browser Assistance System

## Architecture

```
Olaf (main agent)
  └─→ Director (1 instance)
      └─→ Workers (10 instances)
          └─→ Specialized Agents
              ├── LinkedIn Manager (5 agents)
              ├── Image Generators (5 agents)
              └─→ General Browser Workers (10 agents)
```

## Integration Notes

- All tasks follow human-like behavior patterns
- Each step includes:
  - Mouse dynamics
  - Typing patterns
  - Scroll behavior
  - Randomized actions
- Use the API to trigger tasks:
  ```bash
  curl -X POST https://yourdomain.com/api/trigger-director -d '{"steps": [ ... ]}'
  ```

## Status

✅ All social media terms removed
✅ Director running with 10 workers
✅ API ready to accept requests
✅ Cron job triggers every 60 seconds
✅ All 24 agents configured