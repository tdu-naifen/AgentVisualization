---
id: gc_pause_runbook
title: GC Pause Runbook
summary: Address tail-latency spikes caused by garbage-collection stop-the-world pauses.
type: runbook
tags: [gc, jvm, latency]
---

# GC Pause Runbook

Stop-the-world garbage collection freezes the process and shows up as periodic
tail-latency spikes.

## Diagnose
- Correlate latency spikes with GC logs.
- Check allocation rate; a churny hot path forces frequent collections.

## Remediate
- Reduce allocations on the hot path (reuse buffers, avoid boxing).
- Tune the collector / heap size for the workload.
- Size the heap so collections are rare, not just fast.
