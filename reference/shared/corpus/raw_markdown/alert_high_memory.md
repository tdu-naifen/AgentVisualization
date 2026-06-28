---
id: alert_high_memory
title: Alert: High Memory Usage
summary: Monitor definition firing as memory approaches the OOM threshold.
type: alert
tags: [alert, memory, monitor]
---

# Alert: High Memory Usage

- **Query:** avg(last_10m): system.mem.used / system.mem.total by host
- **Threshold:** warn 80%, critical 92%.
- **Runbook:** see Memory Leak / OOM Runbook.
