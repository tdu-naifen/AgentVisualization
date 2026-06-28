---
id: deadlock_runbook
title: Database Deadlock Runbook
summary: Resolve transactions aborting from database deadlocks.
type: runbook
tags: [database, deadlock, transactions]
---

# Database Deadlock Runbook

A deadlock aborts transactions when two of them lock resources in opposite order.

## Diagnose
- Read the deadlock graph from the database log.
- Identify the two transactions and the conflicting lock order.

## Remediate
- Make all code acquire locks in a single canonical order.
- Keep transactions short; do not hold locks across network calls.
- Add a bounded retry with backoff for the victim transaction.
