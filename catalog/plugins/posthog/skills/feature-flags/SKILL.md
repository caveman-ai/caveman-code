---
name: feature-flags
description: Manage the PostHog feature flags this code depends on, finding their uses in the repository, reading their rollout, and changing rollout or cleaning up dead flags with confirmation. Use when asked to roll out, roll back or remove a feature flag.
---

# Manage feature flags

1. Find the flag's key in the code and every place it is checked.
2. Read the flag in PostHog: rollout percentage, conditions and recent evaluations.
3. To change the rollout, show the current and new settings and wait for approval.
4. To remove a fully rolled-out flag, change the code to the winning branch first, then propose archiving the flag once that code is deployed.
