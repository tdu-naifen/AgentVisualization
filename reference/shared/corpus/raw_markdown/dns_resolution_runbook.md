---
id: dns_resolution_runbook
title: DNS Resolution Failure Runbook
summary: Diagnose failures where service names stop resolving.
type: runbook
tags: [dns, network]
---

# DNS Resolution Failure Runbook

When names stop resolving, every dependent call fails fast with NXDOMAIN or
times out waiting on the resolver.

## Diagnose
- Test resolution from the affected host directly.
- Check resolver health and TTL/cache poisoning.

## Remediate
- Fail over to a secondary resolver.
- Increase negative-cache awareness; avoid hammering a sick resolver.
