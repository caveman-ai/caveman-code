---
name: branch-migration
description: Test a database migration on a Neon branch before it touches the main branch by creating the branch, running the migration, comparing schemas and checking queries, then applying or discarding it. Use for any schema change on a Neon project.
---

# Test a migration on a Neon branch

1. Find the Neon project and the branch the app uses (ask if there are several).
2. Create a branch from it, named after the change.
3. Run the migration there, using the repository's migration tool where one exists, so the migration history stays consistent.
4. Compare the schema of the new branch with its parent and check that the diff is exactly what you intended.
5. Run the queries the changed code depends on against the branch and check their plans for sequential scans on large tables.
6. Report the result. Apply to the parent branch only when the user says so, then delete the test branch.
