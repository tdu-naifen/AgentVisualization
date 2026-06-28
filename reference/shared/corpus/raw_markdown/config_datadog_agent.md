---
id: config_datadog_agent
title: Config: Datadog Agent
summary: Example Datadog Agent configuration enabling core checks and tags.
type: config
tags: [config, datadog, agent]
---

# Config: Datadog Agent

```yaml
api_key: ${DD_API_KEY}
tags:
  - env:prod
  - team:sre
logs_enabled: true
process_config:
  enabled: true
apm_config:
  enabled: true
```
Enable process and APM collection so CPU, memory, and trace latency are visible.
