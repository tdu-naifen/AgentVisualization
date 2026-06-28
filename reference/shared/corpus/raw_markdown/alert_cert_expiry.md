---
id: alert_cert_expiry
title: Alert: Certificate Expiring Soon
summary: Monitor definition firing ahead of TLS certificate expiry.
type: alert
tags: [alert, tls, certificate]
---

# Alert: Certificate Expiring Soon

- **Query:** min: tls.cert.days_until_expiry by endpoint
- **Threshold:** warn at 30 days, critical at 7 days.
- **Runbook:** see TLS Certificate Expiry Runbook.
