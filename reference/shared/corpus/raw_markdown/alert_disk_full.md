---
id: alert_disk_full
title: Alert: Disk Almost Full
summary: Monitor definition firing before a volume reaches capacity.
type: alert
tags: [alert, disk, monitor]
---

# Alert: Disk Almost Full

- **Query:** max(last_5m): system.disk.in_use by host,device
- **Threshold:** warn 80%, critical 90%.
- **Runbook:** see Disk Full Runbook.
