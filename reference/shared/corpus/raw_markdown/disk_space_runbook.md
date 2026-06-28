---
id: disk_space_runbook
title: Disk Full Runbook
summary: Recover a node whose disk has filled, causing write failures.
type: runbook
tags: [disk, capacity, storage]
---

# Disk Full Runbook

A full disk causes writes to fail and processes to crash.

## Immediate
- Find the largest directories; rotate or compress oversized logs.
- Clear orphaned temp files and old artifacts.

## Durable Fix
- Add log rotation with a retention cap.
- Alert at 80% so you act before 100%.
- Right-size the volume for steady-state growth.
