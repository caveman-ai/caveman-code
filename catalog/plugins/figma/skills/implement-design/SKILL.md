---
name: implement-design
description: Build a Figma frame or component in this codebase using its existing components, tokens and styles, reading the design's layout, variables and a screenshot from Figma. Use when given a Figma link to implement or to match.
---

# Implement a Figma design

1. Take the node from the link (`node-id` in the URL). Fetch its design context, the variables it uses, and a screenshot to compare against.
2. Before writing markup, find this project's equivalents: components, design tokens, spacing scale and typography. Map each Figma variable to a token; list any with no match.
3. Build with existing components first. Add a new component only when nothing fits, and follow the project's structure for it.
4. Match layout and spacing exactly; for colour and type, use the token, not the raw value from Figma.
5. Render the result (run the app or a story) and compare it with the screenshot. Fix differences, then list anything you could not match and why.
