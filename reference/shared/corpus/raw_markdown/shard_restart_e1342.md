---
id: shard_restart_e1342
title: Shard Restart Error E1342 Runbook
summary: Resolve error code E1342 that appears when a storage shard fails to restart cleanly.
type: runbook
tags: [shard, storage, error-code, e1342]
---

# Shard Restart Error E1342 Runbook

Error **E1342** is raised when a storage shard refuses to come back after a
restart because its write-ahead log (WAL) is in an inconsistent state.

## Trigger
- A shard process restarts (crash, deploy, or node drain).
- On boot it finds an unclean WAL tail and aborts with **E1342**.

## Fix
1. Confirm the code in the shard log: `replay aborted: E1342 unclean WAL tail`.
2. Quarantine the shard from the routing table so reads fail over to replicas.
3. Run `waltool truncate --to-last-checkpoint` to trim the torn tail.
4. Restart the shard; it should replay cleanly and rejoin.
5. If **E1342** repeats, the disk may be returning torn writes — replace it.

## Notes
E1342 is specific to the storage shard layer. It is not the same as the
client-side timeout E1009 or the rebalance warning W2203.
