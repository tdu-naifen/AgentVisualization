---
id: cpu_saturation_runbook
title: CPU Saturation Root-Cause Runbook
summary: Diagnose and remediate an application whose processor is saturated near 100% utilization.
type: runbook
tags: [cpu, performance, saturation, latency]
---

# CPU Saturation Root-Cause Runbook

Why is an application slow, unresponsive, and overloaded, with one process
burning the processor at full capacity? When the workload maxes out compute and
utilization stays pinned near 100 percent, the cores are fully consumed, the run
queue grows, throughput collapses, and tail latency climbs. This root-cause
runbook explains why the processor is the bottleneck and how to shed the load.

## Symptoms
- Sustained utilization above 90% on one or more cores.
- Rising p99 latency and growing run-queue depth.
- Throttling and timeouts downstream.

## Diagnose
1. Identify the hot threads with a sampling profiler; look for a runaway loop or
   a busy-wait spinning without yielding.
2. Check whether a recent deploy changed an algorithm to a quadratic hot path.
3. Separate *real* compute demand from contention (lock spin, GC, serialization).
4. Correlate with traffic: is demand simply above provisioned capacity?

## Remediate
- Shed or rate-limit load to recover headroom immediately.
- Scale out horizontally if demand is legitimate.
- Fix the hot path (cache results, drop the quadratic loop, batch work).
- Pin the regression to a deploy and roll back if it introduced the hot loop.

## Prevent
- Alert on sustained high utilization, not single spikes.
- Load-test the hot path before release; budget headroom for bursts.
