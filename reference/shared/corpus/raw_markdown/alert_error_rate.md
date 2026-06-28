---
id: alert_error_rate
title: Alert: Error Rate Spike
summary: Monitor definition firing on a spike in 5xx error ratio.
type: alert
tags: [alert, errors, 5xx]
---

# Alert: Error Rate Spike

- **Query:** sum(last_5m): http.5xx / http.requests by service
- **Threshold:** critical when ratio > 2% for 5 minutes.
- **First step:** check recent deploys and upstream health.
