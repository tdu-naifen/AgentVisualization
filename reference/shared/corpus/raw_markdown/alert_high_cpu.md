---
id: alert_high_cpu
title: Alert: High CPU Utilization
summary: Monitor definition firing on sustained high processor utilization.
type: alert
tags: [alert, cpu, monitor]
---

# Alert: High CPU Utilization

- **Query:** avg(last_5m): system.cpu.user + system.cpu.system by host
- **Threshold:** warn at 85%, critical at 95% sustained 5 minutes.
- **Why sustained:** single spikes are normal; sustained saturation hurts latency.
- **Runbook:** see CPU Saturation Root-Cause Runbook.
