---
id: rate_limit_runbook
title: Upstream Rate-Limit (429) Runbook
summary: Handle a flood of HTTP 429 responses from a rate-limited upstream.
type: runbook
tags: [rate-limit, 429, upstream]
---

# Upstream Rate-Limit (429) Runbook

A burst of 429s means an upstream is rejecting you for exceeding its quota.

## Diagnose
- Confirm the 429s come from one upstream and started at a traffic change.
- Read the Retry-After header to learn the cool-down.

## Remediate
- Add client-side rate limiting and exponential backoff with jitter.
- Cache upstream responses to cut call volume.
- Negotiate a higher quota if demand is legitimate.
