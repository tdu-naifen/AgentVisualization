---
id: disk_io_latency_runbook
title: Disk I/O Latency Runbook
summary: Resolve high iowait and slow storage that drags down service latency.
type: runbook
tags: [disk, io, latency, iowait]
---

# Disk I/O Latency Runbook

High iowait means the CPU is idle waiting on storage. Throughput drops even
though utilization looks low.

## Diagnose
- Check iowait and per-device await; find the saturated disk.
- Look for a noisy neighbor or a backup job competing for IOPS.
- Inspect for fsync storms from a chatty write path.

## Remediate
- Move hot data to faster storage or add IOPS.
- Batch and coalesce writes; relax fsync where durability allows.
- Throttle background jobs during peak hours.
