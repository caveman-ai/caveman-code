---
name: schema-change
description: Make a Supabase database change the safe way by writing a migration, applying it to a development branch or project first, checking row-level security and the advisors, and then generating types. Use when adding or changing tables, columns, policies or functions on Supabase.
---

# Change a Supabase schema

1. Read the current schema of the affected tables and the repository's migrations folder (`supabase/migrations` by default) so the new migration follows the existing ones.
2. Write the change as a new migration file. Never edit an applied migration.
3. Every new table in an exposed schema gets row-level security enabled and explicit policies. State who can read and write and why.
4. Apply it to a development branch or local stack, never straight to production unless the user says so.
5. Run the security and performance advisors and fix what the change caused.
6. Regenerate the TypeScript types if the project uses them, and update the code that reads the changed tables.
