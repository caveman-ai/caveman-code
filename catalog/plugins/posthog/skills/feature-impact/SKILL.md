---
name: feature-impact
description: Measure how a shipped feature is used with PostHog, finding the events the code sends and querying their volume, unique users and conversion. Use when asked if a feature is used, how it performs, or to check an experiment.
---

# Measure a feature in PostHog

1. Find the events in this repository: search the code for the capture calls around the feature and list their event names and properties.
2. Confirm those events arrive in the PostHog project (recent counts). If they do not, the problem is the instrumentation; say so.
3. Query volume and unique users over time, from before the release to now, and the conversion through the feature's steps when it has more than one.
4. Report the numbers with their time window and filters. Say plainly when the sample is too small to conclude anything.
