---
id: network_latency_runbook
title: Network Latency Spike Runbook
summary: Track down a sudden rise in p99 latency caused by the network path.
type: runbook
tags: [network, latency, p99]
---

# Network Latency Spike Runbook

A p99 latency spike with healthy CPU and memory often points at the network.

## Diagnose
- Compare latency by availability zone; an asymmetric path suggests routing.
- Check retransmits and connection churn.
- Look for a saturated load balancer or a slow upstream dependency.

## Remediate
- Fail over from the degraded path or zone.
- Add connection pooling and keep-alives to cut handshake cost.
- Escalate to the network provider with traceroute evidence.
