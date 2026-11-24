---
name: spec-to-plan
description: Read a spec or design doc in Notion and turn it into an implementation plan for this repository, mapping each requirement to the code that must change. Use when the user points at a Notion page to build from.
---

# Turn a Notion spec into a plan

1. Fetch the page the user names (search by title if no link). Read child pages and linked databases it depends on.
2. Extract the requirements as a numbered list. Mark anything ambiguous or contradictory as an open question.
3. For each requirement, find where it lands in this repository: files, modules and existing patterns to follow.
4. Write the plan: ordered steps, each with the files it touches and how it will be tested. Put the open questions first.
5. Ask the user to settle the open questions before writing code. Offer to add the plan to the Notion page as a comment or a sub-page.
