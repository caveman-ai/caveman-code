---
description: Updates dependencies within their allowed ranges and fixes what the update breaks
---
Update this repository's dependencies to the newest versions their declared ranges allow, with the package manager it already uses. Don't widen a range or take a new major version.

Run the tests. When an update breaks something, fix the code if the fix is small and clear; otherwise hold that package back and say why.

End with what moved (package, from, to), what you held back and why, and anything in the release notes a reviewer should read.
