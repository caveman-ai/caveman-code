---
description: Decides whether an issue is ready to implement or needs more information
decides: [implement, needs_info]
---
Read the issue in the data blocks and the code it points at.

Decide implement when you could write the change and its test from what is there: the problem or the wanted behaviour is clear, and so is where it lives. Decide needs_info when a good engineer would have to ask first: what is expected, how to reproduce it, or which of two readings is meant.

In two or three sentences, say what the change is (or what is missing) and where in the code it goes. End with `decision: implement` or `decision: needs_info`.
