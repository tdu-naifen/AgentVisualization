---
id: alert_queue_depth
title: Alert: Queue Depth Growing
summary: Monitor definition firing when a message queue backlog keeps growing.
type: alert
tags: [alert, queue, backlog]
---

# Alert: Queue Depth Growing

- **Query:** avg(last_10m): mq.messages.ready by queue
- **Threshold:** critical when depth grows monotonically for 10 minutes.
- **Runbook:** see Message Queue Backlog Runbook.
