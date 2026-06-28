---
id: deploy_rollback_procedure
title: Deploy Rollback Procedure
summary: Steps to safely roll back a bad deploy.
type: procedure
tags: [deploy, rollback]
---

# Deploy Rollback Procedure

1. Confirm the regression correlates with the deploy timestamp.
2. Trigger the rollback to the last known-good build.
3. Watch the affected signals recover.
4. Freeze deploys until the root cause is understood.
A fast rollback beats a slow forward-fix during an active incident.
