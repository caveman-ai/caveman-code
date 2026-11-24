---
name: current-docs
description: Fetch current, version-specific documentation for a library before writing or fixing code that uses it, so the code follows today's API rather than a remembered one. Use when working with any third-party library or framework, especially after a major version change or when an API call fails.
---

# Use current library docs

1. Read the library's version from this repository's lockfile or manifest (package.json, pyproject.toml, go.mod, Cargo.toml).
2. Resolve the library to its Context7 ID, then fetch docs for the topic at hand (for example "routing", "middleware" or "auth"), at that version when it is available.
3. Write code against what the docs say. Where they differ from existing code in the repository, follow the repository unless the user wants to migrate.
4. Mention the doc section you relied on when the API choice is not obvious.
