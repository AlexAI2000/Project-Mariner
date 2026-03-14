# Browser Assistance Check

- Check if browser assistance tasks are running
- Monitor active sessions
- Log any errors

# Commands to run:

1. Check if director is running:
   pgrep -f "node /data/human-browser/browser-human.js" && echo "running" || echo "down"

2. View logs:
   tail -f /tmp/director.log

3. Start director if needed:
   bash /data/setup-browser-assistance.sh