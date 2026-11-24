---
name: debug-deployment
description: Find out why a Vercel deployment failed or misbehaves by reading its build logs and runtime logs, then fix the cause in this repository. Use when a Vercel build fails, a preview is broken, or production errors after a deploy.
---

# Debug a Vercel deployment

1. Find the project linked to this repository (`.vercel/project.json` if present, else match by repository) and the deployment: the one named, else the latest for the current branch.
2. If it failed to build, read the build log from the first error. Reproduce with the same build command and Node version locally.
3. If it built but misbehaves, read runtime logs for the failing route around the time of the error.
4. Check the usual causes: missing environment variables in that environment (names only, never print values), Node or framework version drift, and files missing from the build output.
5. Fix, verify the build locally, and report the cause. Redeploy only if the user asks.
