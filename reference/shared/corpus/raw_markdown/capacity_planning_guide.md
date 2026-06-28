---
id: capacity_planning_guide
title: Capacity Planning Guide
summary: How to provision headroom for CPU, memory, and I/O against forecast demand.
type: guide
tags: [capacity, cpu, planning]
---

# Capacity Planning Guide

Provision for peak plus headroom, not average. For CPU, keep steady-state
utilization under ~70% so bursts do not saturate. Re-forecast quarterly and load
test the hot paths so you scale before users feel saturation.
