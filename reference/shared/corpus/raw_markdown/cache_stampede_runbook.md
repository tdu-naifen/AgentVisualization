---
id: cache_stampede_runbook
title: Cache Stampede Runbook
summary: Prevent a thundering herd when a hot cache key expires under load.
type: runbook
tags: [cache, stampede, latency]
---

# Cache Stampede Runbook

When a hot key expires, every request misses at once and stampedes the backend.

## Diagnose
- A latency spike synchronized with a TTL boundary is the signature.
- Backend QPS jumps exactly when the cache entry expires.

## Remediate
- Add request coalescing (single-flight) so one miss refills for all.
- Use a probabilistic early refresh before expiry.
- Serve stale-while-revalidate to absorb the gap.
