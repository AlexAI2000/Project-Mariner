# Browser Assistance API

## Overview

This API allows you to trigger the Browser Assistance Director directly to execute human-like browser tasks. The API is designed for integration with external systems, including your LinkedIn client automation pipeline.

## Endpoints

### POST /api/trigger-director

Triggers the Browser Assistance Director with a task specification.

**Request Body**:
```json
{
  "steps": [
    {
      "action": "goto",
      "url": "https://linkedin.com",
      "exploratoryDetour": 0.25
    },
    {
      "action": "click",
      "selector": "#profile-header",
      "hoverDelay": 300,
      "offsetX": 10,
      "offsetY": 5
    },
    {
      "action": "type",
      "text": "Welcome to my profile",
      "keyDelay": {"min": 50, "max": 200},
      "errorRate": 0.07,
      "realizationPause": 600
    }
  ]
}
```

**Response**:
- `200 OK`: Task successfully queued
- `400 Bad Request`: Invalid task structure
- `503 Service Unavailable`: Director is offline

## Example Usage

```bash
curl -X POST https://yourdomain.com/api/trigger-director \
  -H "Content-Type: application/json" \
  -d '{"steps": [ ... ]}'
```