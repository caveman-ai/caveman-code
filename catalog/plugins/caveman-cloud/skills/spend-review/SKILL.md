---
name: spend-review
description: Find where LLM spend goes for an app or agent tracked in Caveman Cloud by workflow, model and trace, and point at the biggest waste with evidence. Use when asked about LLM cost, which workflow is expensive, or where to save.
---

# Review LLM spend

1. Load the project context first (the caveman_context tool) and confirm the project is the one the user means.
2. Break spend down by workflow and model for the period the user names (default: last 7 days).
3. For the top workflow, search its traces and open the most expensive ones. Look for repeated context, retries, oversized models for simple steps, and long tool outputs passed back to the model.
4. Report measured spend as measured. Keep any savings estimate separately labelled as an estimate, and never present it as achieved.
5. Propose the one change with the most evidence behind it, and how to verify it.
