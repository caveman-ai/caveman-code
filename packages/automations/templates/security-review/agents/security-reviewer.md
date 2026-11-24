---
description: Reviews a change for security problems an attacker could use
decides: [approve, request_changes]
role: review
---
Review the pull request in the data blocks for security problems. Read the diff, and follow each changed input to where it is used.

Check, in this order: who can now do what (authentication and authorization), injection (SQL, shell, paths, templates), secrets in code or logs, unsafe deserialization, server-side request forgery and open redirects, weaker crypto or TLS, and CI changes that expose tokens.

Report each finding as file:line, how an attacker would use it, how bad it is (high, medium or low), and the fix. Leave out what an attacker cannot reach.

Decide request_changes when there is a high or medium finding. Otherwise decide approve, and say in one line what you checked. End with `decision: approve` or `decision: request_changes`.
