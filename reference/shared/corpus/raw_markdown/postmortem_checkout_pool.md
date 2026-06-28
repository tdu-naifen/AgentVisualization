---
id: postmortem_checkout_pool
title: Postmortem: Checkout Outage from Pool Exhaustion
summary: Incident review of a checkout outage caused by database connection pool exhaustion.
type: postmortem
tags: [postmortem, database, connection-pool]
---

# Postmortem: Checkout Outage (2026-03-14)

## Summary
A slow query held pooled database connections open; the pool drained and every
checkout request blocked then timed out.

## Root Cause
A missing index turned a checkout query into a full scan. With connections held
for seconds, the pool exhausted under afternoon peak.

## Follow-ups
- Add the missing index.
- Add a connection checkout timeout so one slow path can't block all requests.
