---
id: postmortem_cache_stampede
title: Postmortem: Homepage Stampede on Cache Expiry
summary: Incident review of a backend overload when a hot homepage cache key expired.
type: postmortem
tags: [postmortem, cache, stampede]
---

# Postmortem: Homepage Stampede (2026-04-08)

## Summary
The cached homepage payload expired at a TTL boundary during peak; every request
missed simultaneously and overwhelmed the render backend.

## Root Cause
No request coalescing: a single expiry turned into thousands of concurrent
backend renders.

## Follow-ups
- Add single-flight coalescing and stale-while-revalidate.
