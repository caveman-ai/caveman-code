---
name: debug-supabase
description: Diagnose a failing Supabase call (auth, database, storage, edge function or realtime) from its logs and the project's configuration. Use when a Supabase request errors, returns nothing unexpectedly, or an edge function crashes.
---

# Debug a Supabase failure

1. Pin down the failing call: which service, which request, the exact error, and when.
2. Read that service's logs for the window around the failure.
3. For empty results or permission errors, check row-level security first: which role the request ran as, and which policy should have allowed it.
4. For edge functions, read the function's logs and its code in `supabase/functions`; check that the secrets it reads are set (names only).
5. Reproduce with the smallest query or request, fix, and confirm the same call now succeeds.
