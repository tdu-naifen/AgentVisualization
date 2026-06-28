---
id: config_retention
title: Config: Telemetry Retention
summary: Retention policy for metrics, logs, and traces by tier.
type: config
tags: [config, retention, cost]
---

# Config: Telemetry Retention

- Metrics: 15 months rolled up; 15 days at full resolution.
- Logs: 30 days hot, 90 days archived.
- Traces: 7 days, 100% of errors retained, 10% sampled otherwise.
Retention is a cost lever: keep errors longer, sample the rest.
