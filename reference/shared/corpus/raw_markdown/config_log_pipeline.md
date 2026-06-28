---
id: config_log_pipeline
title: Config: Log Pipeline with PII Scrubbing
summary: Log pipeline config that redacts emails and IPs before indexing.
type: config
tags: [config, logs, pii]
---

# Config: Log Pipeline with PII Scrubbing

```yaml
processors:
  - type: string-replace
    pattern: '[\w.+-]+@[\w-]+\.[\w.-]+'
    replace: '[REDACTED_EMAIL]'
  - type: string-replace
    pattern: '\b\d{1,3}(\.\d{1,3}){3}\b'
    replace: '[REDACTED_IP]'
```
Scrub PII at ingest so it never lands in the index — defense in depth for §07.
