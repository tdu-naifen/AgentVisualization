---
id: postmortem_cpu_runaway
title: Postmortem: CPU Runaway in Search Service
summary: Incident review of a deploy that introduced a CPU-saturating hot loop in search.
type: postmortem
tags: [postmortem, cpu, saturation]
---

# Postmortem: CPU Runaway in Search Service (2026-05-02)

This is a historical postmortem of one specific dated production incident in the
search service on 2026-05-02 — a retrospective record of that single event, not
a general troubleshooting guide.

## Summary
A deploy introduced a quadratic ranking loop. Under normal traffic the search
workload saturated all cores; utilization pinned at 100% and p99 latency tripled.

## Timeline
- 14:02 deploy ships.
- 14:09 high-CPU alert fires; latency climbing.
- 14:21 hot threads traced to the ranking loop.
- 14:25 rollback; utilization recovers within two minutes.

## Root Cause
An O(n^2) re-rank ran on every request. Real demand was normal; the code was the
problem, not capacity.

## Follow-ups
- Add a load test for the ranking path.
- Alert on sustained saturation, not spikes.
