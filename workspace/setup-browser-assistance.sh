#!/bin/bash
# Browser assistance startup script

# Ensure director is stopped first
if [ -f /tmp/director.pid ]; then
    kill -9 $(cat /tmp/director.pid) 2>/dev/null
    rm -f /tmp/director.pid
fi

# Start director in background
/data/human-browser/director --log /tmp/director.log > /tmp/director.log 2>&1 &
echo $! > /tmp/director.pid
