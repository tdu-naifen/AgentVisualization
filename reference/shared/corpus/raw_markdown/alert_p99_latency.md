---
id: alert_p99_latency
title: Alert: p99 Latency High
summary: Monitor definition firing when request tail latency breaches the SLO.
type: alert
tags: [alert, latency, slo]
---

# Alert: p99 Latency High

- **Query:** p99(last_5m): trace.http.request.duration by service
- **Threshold:** critical when p99 > 500ms for 5 minutes.
- **Runbooks:** Network Latency, GC Pause, DB Connection Pool.
