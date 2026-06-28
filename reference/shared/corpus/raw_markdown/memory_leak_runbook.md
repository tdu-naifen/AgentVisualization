---
id: memory_leak_runbook
title: Memory Leak / OOM Runbook
summary: Diagnose steadily growing resident memory ending in out-of-memory kills.
type: runbook
tags: [memory, oom, leak]
---

# Memory Leak / OOM Runbook

A leak shows as resident memory (RSS) growing without bound until the kernel OOM
killer terminates the process.

## Diagnose
- Plot RSS over hours; a sawtooth that trends up signals a leak.
- Capture a heap profile; look for an ever-growing cache or unbounded queue.
- Check for missing eviction or for objects pinned by a global registry.

## Remediate
- Add a bound/eviction to the offending cache or queue.
- Restart on a schedule as a stopgap while the leak is fixed.
- Set a memory limit and alert before the OOM, not after.
