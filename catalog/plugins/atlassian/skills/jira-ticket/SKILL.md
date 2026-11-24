---
name: jira-ticket
description: Carry a Jira issue from reading it to a finished change by reading the issue and linked Confluence pages, implementing it here, and updating the issue with a comment and transition. Use when the user names a Jira key (like PROJ-123) or asks to start on their next ticket.
---

# Work a Jira ticket

1. Fetch the issue by key, or the user's assigned issues in the current sprint by priority. Confirm which one.
2. Read its description, acceptance criteria, comments, linked issues and any Confluence pages it links.
3. Create a branch whose name starts with the issue key so Jira links the work.
4. Implement it with tests.
5. Comment on the issue with what changed and the link to the commit or PR. Transition it only to the state the user asks for.
