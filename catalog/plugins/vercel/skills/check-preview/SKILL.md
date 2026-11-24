---
name: check-preview
description: Check the Vercel preview deployment for the current branch by confirming its status and URL, and look for build warnings or runtime errors before review. Use when the user asks if the preview is up or ready.
---

# Check the preview deployment

1. Find the latest deployment for the current branch and its state (building, ready, error).
2. If it is ready, give the preview URL. If it is still building, say so and when it started.
3. Scan its build log for warnings that matter (deprecated config, large functions, missing env names) and its runtime logs for errors since it went live.
4. Report the URL, the state and anything worth fixing before review.
