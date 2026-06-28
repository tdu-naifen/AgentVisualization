---
id: postmortem_tls_expiry
title: Postmortem: API Outage from Expired Certificate
summary: Incident review of an outage caused by a TLS certificate nobody renewed.
type: postmortem
tags: [postmortem, tls, certificate]
---

# Postmortem: API Outage from Expired Certificate (2026-02-11)

## Summary
The public API certificate expired at midnight; all TLS handshakes failed for 38
minutes until a renewed cert was rolled.

## Root Cause
Renewal automation silently failed weeks earlier and the expiry alert was routed
to an unmonitored channel.

## Follow-ups
- Fix the ACME renewal job and add a synthetic check.
- Route expiry alerts to the on-call channel.
