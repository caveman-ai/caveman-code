---
name: find-dataset
description: Find datasets on the Hugging Face Hub for training or evaluation, checking licence, size, splits, columns and sample rows before recommending one. Use when the user needs data for a model, an eval or a test.
---

# Find a dataset on the Hub

1. Restate what the data must contain: inputs, labels, language, size, and licence needs.
2. Search the Hub and shortlist datasets by relevance and downloads.
3. For each, read the dataset card and check splits, columns, row counts, licence and how it was collected.
4. Look at a few sample rows for quality problems (duplicates, wrong labels, leaked test data).
5. Recommend one, with the code to load it, and say what it lacks.
