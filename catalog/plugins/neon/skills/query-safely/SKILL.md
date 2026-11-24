---
name: query-safely
description: Run SQL against a Neon database without surprises by reading first, limiting row counts, and wrapping writes in an explicit, confirmed step. Use when asked to look at, count or fix data in a Neon database.
---

# Query Neon safely

1. Confirm the project, branch and database before the first query.
2. Read the table definitions before querying them.
3. Start with read-only queries with a LIMIT. Aggregate rather than dumping rows; do not print columns that hold personal data or secrets.
4. For a write, show the exact statement and the count of rows it will touch (from a SELECT with the same WHERE). Run it only after the user agrees, preferably on a branch first.
