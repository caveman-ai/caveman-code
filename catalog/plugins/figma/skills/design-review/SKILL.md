---
name: design-review
description: Compare a screen or component that is already built against its Figma design and list the differences in layout, spacing, colour, type and states. Use when asked whether the UI matches the design.
---

# Review a build against its design

1. Fetch the Figma node's screenshot and design context, including variants for hover, focus, disabled, empty and error states.
2. Run the app and capture the same screen at the same width.
3. Compare region by region. Record each difference with the expected value (from Figma), the actual value (from the code), and the file to change.
4. Separate real mismatches from intentional platform differences, and ask about the ambiguous ones.
5. Fix them if the user asks; otherwise hand over the list, most visible first.
