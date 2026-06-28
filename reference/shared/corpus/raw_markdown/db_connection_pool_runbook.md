---
id: db_connection_pool_runbook
title: Database Connection Pool Exhaustion Runbook
summary: Fix request stalls caused by an exhausted database connection pool.
type: runbook
tags: [database, connection-pool, latency]
---

# Database Connection Pool Exhaustion Runbook

When every pooled connection is checked out, new requests block and time out.

## Diagnose
- Watch active vs idle connections; a flat-lined pool at max is the tell.
- Find slow queries holding connections too long.
- Look for a leak: code paths that never return a connection.

## Remediate
- Kill or optimize the slow queries.
- Add a checkout timeout so a stuck request fails fast instead of blocking all.
- Right-size the pool; do not just raise the cap blindly.
