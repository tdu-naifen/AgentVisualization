---
id: config_autoscaling
title: Config: Horizontal Autoscaling
summary: Example autoscaler policy that scales on CPU utilization.
type: config
tags: [config, autoscaling, cpu]
---

# Config: Horizontal Autoscaling

```yaml
minReplicas: 3
maxReplicas: 20
metrics:
  - type: Resource
    resource:
      name: cpu
      target:
        type: Utilization
        averageUtilization: 70
```
Scale out before saturation: target 70% so there is burst headroom.
