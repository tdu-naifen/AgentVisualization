---
id: shard_rebalance_runbook
title: Shard Rebalancing and Restart Runbook
summary: Safely rebalance and restart storage shards during scale-up without data loss.
type: runbook
tags: [shard, storage, rebalance, restart]
---

# Shard Rebalancing and Restart Runbook

Rebalancing moves key ranges between storage shards when you add or drain nodes.
Restarting shards in the wrong order can stall the cluster, so follow this order.

## When to Rebalance
- After adding capacity, to spread hot key ranges.
- Before draining a node for maintenance.

## Safe Restart Procedure
1. Mark the target shard read-only and let replicas take read traffic.
2. Wait for in-flight writes to drain.
3. Restart the shard process and watch it rejoin the routing table.
4. Re-enable writes once the shard reports healthy.

## Cautions
Never restart a majority of shards at once or you lose quorum. Watch replication
lag during the restart; a lagging replica can serve stale reads.
