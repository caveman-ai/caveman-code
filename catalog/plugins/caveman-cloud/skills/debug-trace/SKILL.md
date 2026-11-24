---
name: debug-trace
description: Debug a failing or surprising run of an agent tracked in Caveman Cloud by finding its trace, reading its steps, and tracing the problem back to the code in this repository. Use when the user reports a bad agent answer, an error, or a slow run.
---

# Debug an agent run from its trace

1. Find the trace: by ID if given, else search traces by workflow, time window and error status.
2. Read it step by step: prompts, model calls, tool calls and their results, latency and tokens.
3. Find the first step where the run went wrong (a bad tool result, a missing piece of context, a wrong model choice).
4. Map that step to the code in this repository that built the prompt or called the tool.
5. Propose a fix, and an eval case built from this trace so the failure stays fixed.
