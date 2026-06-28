---
id: certificate_expiry_runbook
title: TLS Certificate Expiry Runbook
summary: Recover from an outage caused by an expired TLS certificate.
type: runbook
tags: [tls, certificate, security]
---

# TLS Certificate Expiry Runbook

An expired certificate breaks every TLS handshake; clients see cert errors.

## Immediate
- Confirm the not-after date on the served certificate.
- Roll the renewed certificate and reload the terminators.

## Prevent
- Automate renewal (ACME) well before expiry.
- Alert 30 days out and again at 7 days.
