---
id: postmortem_shard_e1342
title: Postmortem: Shard Outage from E1342 After Power Event
summary: Incident review where multiple shards failed to restart with error E1342.
type: postmortem
tags: [postmortem, shard, e1342]
---

# Postmortem: Shard Outage from E1342 (2026-01-20)

## Summary
A rack power blip restarted several storage shards simultaneously. Three came
back with **E1342** (unclean WAL tail) and stayed down until WAL truncation.

## Root Cause
Torn writes during the abrupt power loss left the WAL tail inconsistent, so the
shards aborted replay with **E1342** on boot.

## Follow-ups
- Automate the WAL-truncate-and-restart step from the E1342 runbook.
- Stagger shard restarts to preserve quorum.
