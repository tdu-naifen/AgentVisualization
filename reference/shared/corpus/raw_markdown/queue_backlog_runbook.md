---
id: queue_backlog_runbook
title: Message Queue Backlog Runbook
summary: Drain a growing message-queue backlog before it breaches SLA.
type: runbook
tags: [queue, backlog, throughput]
---

# Message Queue Backlog Runbook

A backlog grows when producers outpace consumers; end-to-end latency balloons.

## Diagnose
- Compare enqueue vs dequeue rate; a persistent gap means under-capacity.
- Check for a poison message stalling a partition.

## Remediate
- Scale out consumers to close the rate gap.
- Quarantine poison messages to a dead-letter queue.
- Shed or prioritize if the backlog threatens SLA.
