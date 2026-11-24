// ), packages/provider-core/src/server/textGenerationPrompts.test.ts @ ab3a3cd1.
import { describe, expect, it } from "vitest";
import * as Schema from "effect/Schema";

import {
  buildBranchNamePrompt,
  buildCommitMessagePrompt,
  buildPrContentPrompt,
  buildReviewGuideChunkPrompt,
  buildReviewGuidePrompt,
  buildReviewGuideTldrPrompt,
  buildThreadTitlePrompt,
  cleanThreadTopic,
  cleanThreadTopicIcon,
} from "./textGenerationPrompts.ts";
import { withTopic } from "./textGenerationOperations.ts";
import { reviewGuideChunks } from "./reviewGuideChunks.ts";
import {
  normalizeCliError,
  sanitizeThreadTitle,
  toJsonSchemaObject,
} from "./textGenerationUtils.ts";
import { TextGenerationError } from "@caveman-app/protocol";

describe("buildCommitMessagePrompt", () => {
  it("includes staged patch and summary in the prompt", () => {
    const result = buildCommitMessagePrompt({
      branch: "main",
      stagedSummary: "M README.md",
      stagedPatch: "diff --git a/README.md b/README.md\n+hello",
      includeBranch: false,
    });

    expect(result.prompt).toContain("Staged files:");
    expect(result.prompt).toContain("M README.md");
    expect(result.prompt).toContain("Staged patch:");
    expect(result.prompt).toContain("diff --git a/README.md b/README.md");
    expect(result.prompt).toContain("Branch: main");
    // Should NOT include the branch generation instruction
    expect(result.prompt).not.toContain("branch must be a short semantic git branch fragment");
  });

  it("includes branch generation instruction when includeBranch is true", () => {
    const result = buildCommitMessagePrompt({
      branch: "feature/foo",
      stagedSummary: "M README.md",
      stagedPatch: "diff",
      includeBranch: true,
    });

    expect(result.prompt).toContain("branch must be a short semantic git branch fragment");
    expect(result.prompt).toContain("Return a JSON object with keys: subject, body, branch.");
  });

  it("shows (detached) when branch is null", () => {
    const result = buildCommitMessagePrompt({
      branch: null,
      stagedSummary: "M a.ts",
      stagedPatch: "diff",
      includeBranch: false,
    });

    expect(result.prompt).toContain("Branch: (detached)");
  });

  it("includes policy instructions", () => {
    const result = buildCommitMessagePrompt({
      branch: "main",
      stagedSummary: "M a.ts",
      stagedPatch: "diff",
      includeBranch: false,
      policy: {
        kind: "custom",
        commitInstructions: "Use a terse repository-specific subject.",
        inferRepositoryConventions: false,
      },
    });

    expect(result.prompt).toContain("Additional instructions:");
    expect(result.prompt).toContain("Use a terse repository-specific subject.");
  });
});

describe("buildPrContentPrompt", () => {
  it("includes branch names, commits, and diff in the prompt", () => {
    const result = buildPrContentPrompt({
      baseBranch: "main",
      headBranch: "feature/auth",
      commitSummary: "feat: add login page",
      diffSummary: "3 files changed",
      diffPatch: "diff --git a/auth.ts b/auth.ts\n+export function login()",
    });

    expect(result.prompt).toContain("Base branch: main");
    expect(result.prompt).toContain("Head branch: feature/auth");
    expect(result.prompt).toContain("Commits:");
    expect(result.prompt).toContain("feat: add login page");
    expect(result.prompt).toContain("Diff stat:");
    expect(result.prompt).toContain("3 files changed");
    expect(result.prompt).toContain("Diff patch:");
    expect(result.prompt).toContain("export function login()");
    expect(result.prompt).toContain("include headings '## Summary' and '## Testing'");
  });

  it("follows a repository PR template instead of the default body headings", () => {
    const result = buildPrContentPrompt({
      baseBranch: "main",
      headBranch: "feature/auth",
      commitSummary: "feat: add login page",
      diffSummary: "3 files changed",
      diffPatch: "diff",
      changeRequestTemplate: "<!-- remove me -->\n## What changed\n\n## Verification",
      policy: {
        kind: "custom",
        changeRequestInstructions: "Keep the title in sentence case.",
        inferRepositoryConventions: false,
      },
    });

    expect(result.prompt).toContain("Keep the title in sentence case.");
    expect(result.prompt).toContain("follow the repository change request template structure");
    expect(result.prompt).toContain("drop HTML comments from the template");
    expect(result.prompt).toContain("Repository change request template:");
    expect(result.prompt).toContain("<!-- remove me -->\n## What changed\n\n## Verification");
    expect(result.prompt).not.toContain("include headings '## Summary' and '## Testing'");
  });
});

describe("buildBranchNamePrompt", () => {
  it("requests a semantic prefix as part of the same branch response", () => {
    const { prompt, outputSchema } = buildBranchNamePrompt({
      message: "Add search",
      naming: { mode: "semantic", prefix: "ignored", instructions: "ignored instruction" },
    });
    expect(prompt).toContain("feat/add-search");
    expect(prompt).not.toContain("ignored instruction");
    expect(toJsonSchemaObject(outputSchema)).toMatchObject({ required: ["branch"] });
  });
  it("appends custom instructions without imposing a prefix, case or word limit", () => {
    const { prompt } = buildBranchNamePrompt({
      message: "Add search",
      naming: {
        mode: "custom",
        prefix: "ignored",
        instructions: "Use Julius/ABC-123 and preserve capitalization.",
      },
    });
    expect(prompt).toContain("Use Julius/ABC-123 and preserve capitalization.");
    expect(prompt).toContain("complete branch name");
    expect(prompt).not.toContain("2-6 words");
    expect(prompt).not.toContain("lowercase");
    expect(prompt).not.toContain("no issue prefixes");
  });
  it("asks for just the fragment in static mode", () => {
    const { prompt } = buildBranchNamePrompt({
      message: "Add search",
      naming: { mode: "static", prefix: "team", instructions: "ignored instruction" },
    });
    expect(prompt).toContain("without a prefix or namespace");
    expect(prompt).not.toContain("ignored instruction");
  });

  it("includes the user message in the prompt", () => {
    const result = buildBranchNamePrompt({
      message: "Fix the login timeout bug",
    });

    expect(result.prompt).toContain("User message:");
    expect(result.prompt).toContain("Fix the login timeout bug");
    expect(result.prompt).not.toContain("Attachment metadata:");
  });

  it("includes attachment metadata when attachments are provided", () => {
    const result = buildBranchNamePrompt({
      message: "Fix the layout from screenshot",
      attachments: [
        {
          type: "image" as const,
          id: "att-123",
          name: "screenshot.png",
          mimeType: "image/png",
          sizeBytes: 12345,
        },
      ],
    });

    expect(result.prompt).toContain("Attachment metadata:");
    expect(result.prompt).toContain("screenshot.png");
    expect(result.prompt).toContain("image/png");
    expect(result.prompt).toContain("12345 bytes");
  });
});

describe("buildReviewGuidePrompt", () => {
  const input = {
    number: 42,
    title: "Add search",
    description: "",
    baseBranch: "main",
    baseCommit: "abc123",
    settledReview: "",
  };

  it("adds the maintainer's preferences after the change context", () => {
    const { prompt } = buildReviewGuidePrompt({
      ...input,
      instructions: "  Skip test files unless they change behavior.  ",
    });
    const preferences = prompt.indexOf("The maintainer's preferences for guides:");
    expect(preferences).toBeGreaterThan(prompt.indexOf("Already settled in review:"));
    expect(prompt.slice(preferences)).toContain("Skip test files unless they change behavior.");
    expect(prompt.slice(preferences)).toContain("do not change the JSON format");
  });

  it("names the stack's other layers as context the guide may point at", () => {
    const { prompt } = buildReviewGuidePrompt({
      ...input,
      stack: [
        { number: 41, title: "Add the index", headSha: "aaa111", state: "merged" },
        { number: 42, title: "Add search", headSha: "bbb222", state: "open" },
        { number: 43, title: "Search UI", headSha: null, state: "open" },
      ],
    });
    expect(prompt).toContain("1. #41: Add the index, merged, head aaa111");
    expect(prompt).toContain("2. #42 (this change): Add search\n");
    expect(prompt).toContain("3. #43: Search UI, head not available");
    expect(prompt).toContain("Never excerpt another layer's code");
  });

  it("leaves the stack out for a change that is not in one", () => {
    expect(buildReviewGuidePrompt(input).prompt).not.toContain("layer of a stack");
    expect(
      buildReviewGuidePrompt({
        ...input,
        stack: [{ number: 42, title: "Add search", headSha: "bbb222", state: "open" }],
      }).prompt,
    ).not.toContain("layer of a stack");
  });

  it("asks for a caveman-terse overview, a before/after and action titles", () => {
    const { prompt, outputSchema } = buildReviewGuidePrompt(input);
    expect(prompt).toContain("terse and legible");
    expect(prompt).toContain("No arrows in prose.");
    expect(prompt).toContain("Never write broken grammar or play a character");
    expect(prompt).toContain("four keys: tldr, overview, before_after and stops");
    expect(prompt).toContain("tldr: the whole change in one or two short sentences");
    expect(prompt).toContain("at most 7 words in present tense");
    expect(prompt).toContain("summary: exactly three lines, in this order: `before: <how it was>`, `after: <how it is now>`, `why: <why that matters>`");
    expect(prompt).not.toContain("two to four sentences");
    expect(Object.keys(outputSchema.fields)).toEqual(["tldr", "overview", "before_after", "stops"]);
  });

  it("puts the change map at the top of an investigating run", () => {
    const { prompt } = buildReviewGuidePrompt({ ...input, changeMap: "code src/a.ts +3 -1 · function a" });
    const map = prompt.indexOf("<change_map>\ncode src/a.ts +3 -1 · function a\n</change_map>");
    expect(map).toBeGreaterThan(0);
    expect(map).toBeLessThan(prompt.indexOf("Investigate before you answer"));
    expect(prompt).toContain("git diff --stat abc123...HEAD");
    expect(prompt).not.toContain("<diff>");
  });

  it("writes a single pass over labelled chunks it cites by id, with no tools or checkout", () => {
    const chunks = reviewGuideChunks(
      "diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1,0 +1,3 @@\n+a\n+b\n+c\n",
    );
    const { prompt, outputSchema } = buildReviewGuideChunkPrompt(
      {
        ...input,
        changeMap: "code src/a.ts +3 -0",
        stack: [
          { number: 41, title: "Add the index", headSha: "aaa111", state: "merged" },
          { number: 42, title: "Add search", headSha: "bbb222", state: "open" },
        ],
      },
      chunks,
    );
    expect(prompt).toContain("you have no tools and no checkout");
    expect(prompt).not.toContain("Investigate before you answer");
    expect(prompt).not.toContain("git diff --stat");
    expect(prompt).not.toContain("git show <that head>");
    expect(prompt).toContain("cut into chunks [C1]..[C1]");
    expect(prompt).toContain("never write line numbers");
    expect(prompt).toContain("- chunks: the code worth showing");
    expect(prompt).toContain("{chunk, quote, title, body}");
    expect(prompt).not.toContain("- excerpts:");
    expect(prompt.endsWith("<diff>\n[C1] src/a.ts (new 1-3)\n+a\n+b\n+c\n</diff>")).toBe(true);
    const stop = toJsonSchemaObject(outputSchema) as {
      properties: { stops: { items: { properties: Record<string, unknown> } } };
    };
    expect(Object.keys(stop.properties.stops.items.properties)).toEqual([
      "title",
      "summary",
      "attention",
      "chunks",
      "notes",
      "files",
      "questions",
    ]);
  });

  it("leaves the section out when there are no preferences", () => {
    expect(buildReviewGuidePrompt(input).prompt).not.toContain("preferences for guides");
    expect(buildReviewGuidePrompt({ ...input, instructions: "  " }).prompt).not.toContain(
      "preferences for guides",
    );
  });

  it("gives the chat's own TL;DR as the author's claim to check, beside the pull request's text", () => {
    const { prompt } = buildReviewGuidePrompt({ ...input, chatTldr: " Merge locks on red CI.\nStops bad merges. " });
    const claim = prompt.indexOf("<chat_tldr>Merge locks on red CI. Stops bad merges.</chat_tldr>");
    expect(claim).toBeGreaterThan(prompt.indexOf("<settled_review>"));
    expect(prompt.slice(claim)).toContain("Check it against the diff");
    expect(buildReviewGuidePrompt(input).prompt).not.toContain("<chat_tldr>");
  });
});

describe("buildReviewGuideTldrPrompt", () => {
  const diff = "diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1,0 +1,2 @@\n+a\n+b\n";
  const input = (overrides: Record<string, unknown> = {}) => ({
    number: 42,
    title: "Add search",
    description: "Adds search.",
    baseBranch: "main",
    baseCommit: "abc123",
    settledReview: "",
    ...overrides,
  });

  it("asks for a TL;DR and at most one call, in the guides' voice, over the diff as it is", () => {
    const { prompt, outputSchema } = buildReviewGuideTldrPrompt(input(), diff);
    expect(Object.keys(outputSchema.fields)).toEqual(["tldr", "attention"]);
    expect(prompt).toContain("two keys: tldr and attention");
    expect(prompt).toContain("tldr: the whole change in one or two short sentences, at most 120 characters: what it does, then why it matters");
    expect(prompt).toContain("most short changes have null");
    expect(prompt).toContain("Do not invent concerns.");
    expect(prompt).toContain("terse and legible");
    expect(prompt).toContain("you have no tools and no checkout");
    expect(prompt).not.toContain("stops");
    expect(prompt).not.toContain("[C1]");
    expect(prompt.endsWith(`<diff>\n${diff.trimEnd()}\n</diff>`)).toBe(true);
  });

  it("puts every fixed instruction, then the maintainer's preferences, before anything about the pull request", () => {
    const one = buildReviewGuideTldrPrompt(input({ instructions: "Say why first." }), diff).prompt;
    const other = buildReviewGuideTldrPrompt(
      input({ number: 7, title: "Fix login", description: "", baseCommit: "def456", instructions: "Say why first.", chatTldr: "Fixes login." }),
      "diff --git a/b.ts b/b.ts\n",
    ).prompt;
    const prefix = one.slice(0, one.indexOf("Change request #42"));
    expect(prefix).toContain("Say why first.");
    expect(prefix).not.toContain("Add search");
    expect(prefix).not.toContain("abc123");
    expect(other.startsWith(prefix)).toBe(true);
    expect(other).toContain("<chat_tldr>Fixes login.</chat_tldr>");
  });
});

describe("buildThreadTitlePrompt", () => {
  it("requires each generated field in the strict response schema", () => {
    const { outputSchema } = buildThreadTitlePrompt({ message: "Fix this" });
    expect(toJsonSchemaObject(outputSchema)).toMatchObject({
      required: ["title", "needsRefinement", "topic", "icon"],
      properties: { title: { type: "string" }, needsRefinement: { type: "boolean" } },
    });
  });

  it("asks for the thread's topic and its emoji, offering the person's existing topics with theirs to reuse", () => {
    const topics = [{ name: "Billing Redesign", icon: "💸" }, { name: "Relay Reliability" }];
    for (const { prompt, outputSchema } of [
      buildThreadTitlePrompt({ message: "Fix this", topics }),
      buildThreadTitlePrompt({ message: "Fix this", previousTitle: "Login crash", topics }),
    ]) {
      expect(prompt).toContain("Return JSON with keys title, needsRefinement, topic and icon.");
      expect(prompt).toContain("- 💸 Billing Redesign\n- Relay Reliability");
      expect(prompt).toContain("return that topic's name exactly as written");
      expect(prompt).toContain("Set icon to one emoji that pictures the topic");
      expect(toJsonSchemaObject(outputSchema)).toMatchObject({
        required: ["title", "needsRefinement", "topic", "icon"],
        properties: {
          topic: { anyOf: [{ type: "string" }, { type: "null" }] },
          icon: { anyOf: [{ type: "string" }, { type: "null" }] },
        },
      });
      // A writer that leaves them out, or answers null, still lands its title.
      expect(Schema.decodeUnknownSync(outputSchema)({ title: "Login crash" })).toMatchObject({ title: "Login crash", topic: null, icon: null });
    }
    expect(buildThreadTitlePrompt({ message: "Fix this" }).prompt).not.toContain("existing topics");
  });

  it("keeps a topic to one clean line, in an existing topic's own spelling", () => {
    expect(cleanThreadTopic('  "relay   reliability."  ', [{ name: "Relay Reliability" }])).toBe("Relay Reliability");
    expect(cleanThreadTopic("Sidebar Grouping", [])).toBe("Sidebar Grouping");
    expect(cleanThreadTopic("  ", [])).toBeUndefined();
    expect(cleanThreadTopic(null, [])).toBeUndefined();
    expect(cleanThreadTopic("x".repeat(60), [])).toHaveLength(40);
    // The emoji copied from the topics list never becomes part of the name.
    expect(cleanThreadTopic("🧭 sidebar grouping", [{ name: "Sidebar Grouping", icon: "🧭" }])).toBe("Sidebar Grouping");
    expect(cleanThreadTopic("👩‍💻 Dev Tools", [])).toBe("Dev Tools");
  });

  it("keeps a topic's emoji only when it is exactly one emoji", () => {
    expect(cleanThreadTopicIcon("🧭")).toBe("🧭");
    expect(cleanThreadTopicIcon(" 🧭 ")).toBe("🧭");
    expect(cleanThreadTopicIcon("🇳🇱")).toBe("🇳🇱");
    expect(cleanThreadTopicIcon("👩‍💻")).toBe("👩‍💻");
    expect(cleanThreadTopicIcon("👍🏽")).toBe("👍🏽");
    expect(cleanThreadTopicIcon("ab")).toBeUndefined();
    expect(cleanThreadTopicIcon("a")).toBeUndefined();
    expect(cleanThreadTopicIcon("🧭🧭")).toBeUndefined();
    expect(cleanThreadTopicIcon("")).toBeUndefined();
    expect(cleanThreadTopicIcon(" 🧭 x")).toBeUndefined();
    expect(cleanThreadTopicIcon(null)).toBeUndefined();
  });

  it("brings a topic's emoji only with a topic", () => {
    expect(withTopic({ topic: "Sidebar Grouping", icon: "🧭" }, [])).toEqual({ topic: "Sidebar Grouping", icon: "🧭" });
    expect(withTopic({ topic: "Sidebar Grouping", icon: "sidebar" }, [])).toEqual({ topic: "Sidebar Grouping" });
    expect(withTopic({ topic: null, icon: "🧭" }, [])).toEqual({});
  });

  it("includes the user message without absent attachment metadata", () => {
    const result = buildThreadTitlePrompt({
      message: "Investigate reconnect regressions after session restore",
    });

    expect(result.prompt).toContain("User message:");
    expect(result.prompt).toContain("Investigate reconnect regressions after session restore");
    expect(result.prompt).not.toContain("Attachment metadata:");
  });

  it("includes attachment metadata when attachments are provided", () => {
    const result = buildThreadTitlePrompt({
      message: "Name this thread from the screenshot",
      attachments: [
        {
          type: "image" as const,
          id: "att-456",
          name: "thread.png",
          mimeType: "image/png",
          sizeBytes: 67890,
        },
      ],
    });

    expect(result.prompt).toContain("Attachment metadata:");
    expect(result.prompt).toContain("thread.png");
    expect(result.prompt).toContain("image/png");
    expect(result.prompt).toContain("67890 bytes");
  });

  it("regenerates from recent thread contents and identifies the previous title", () => {
    const result = buildThreadTitlePrompt({
      message: `USER:\nInvestigate reconnect regressions\n\nASSISTANT:\nThe remaining issue is stale session state`,
      previousTitle: "Investigate reconnect regressions",
    });

    expect(result.prompt).toContain(
      "Regenerate the title for an existing Caveman Code thread so the user can recognize it weeks later.",
    );
    expect(result.prompt).toContain('The previous title was "Investigate reconnect regressions".');
    expect(result.prompt).toContain("Thread contents:");
    expect(result.prompt).toContain("The remaining issue is stale session state");
  });

  it("keeps the latest thread contents when regeneration context is truncated", () => {
    const result = buildThreadTitlePrompt({
      message: `${"old context ".repeat(1_000)}\n\nASSISTANT:\nCurrent thread state`,
      previousTitle: "Old title",
    });

    expect(result.prompt).toContain("[Earlier content truncated]");
    expect(result.prompt).toContain("Current thread state");
    expect(result.prompt).not.toContain("[truncated]");
  });

  it("does not truncate an already-marked regeneration context twice", () => {
    const retainedContext = "x".repeat(7_998);
    const result = buildThreadTitlePrompt({
      message: `[Earlier content truncated]\n\n${retainedContext}`,
      previousTitle: "Old title",
    });

    expect(result.prompt).toContain(
      `Thread contents:\n[Earlier content truncated]\n\n${retainedContext}`,
    );
    expect(result.prompt.match(/\[Earlier content truncated\]/g)).toHaveLength(1);
  });
});

describe("sanitizeThreadTitle", () => {
  it.each([
    '{"title": "Refresh ev-stg APP ASG instances"}',
    '{\n  "title": "Refresh ev-stg APP ASG instances"\n}',
  ])("unwraps a JSON title before normalizing: %s", (raw) => {
    expect(sanitizeThreadTitle(raw)).toBe("Refresh ev-stg APP ASG instances");
  });

  it.each([
    "Rolling ES Refresh ev-stg",
    "Fix {title} interpolation",
    '{"title": 42}',
    '{"subject": "Fix parsing"}',
    '{"title": "unfinished}',
  ])("preserves text that is not a JSON title: %s", (raw) => {
    expect(sanitizeThreadTitle(raw)).toBe(raw);
  });

  it("normalizes the extracted title", () => {
    expect(sanitizeThreadTitle('{"title": "  Fix   reconnect failures  "}')).toBe(
      "Fix reconnect failures",
    );
    expect(sanitizeThreadTitle('{"title": "  "}')).toBe("New thread");
    expect(
      sanitizeThreadTitle(
        '{"title": "Reconnect failures after restart because the session state does not recover"}',
      ),
    ).toBe("Reconnect failures after restart because the session state does not recover");
  });

  it("keeps complete titles for client display truncation", () => {
    expect(
      sanitizeThreadTitle(
        '  "Reconnect failures after restart because the session state does not recover"  ',
      ),
    ).toBe("Reconnect failures after restart because the session state does not recover");
  });

  it("caps runaway titles so a paragraph cannot reach the sidebar", () => {
    const words = Array.from({ length: 40 }, (_, index) => `word${index}`).join(" ");
    const title = sanitizeThreadTitle(words);
    expect(title.length).toBeLessThanOrEqual(120);
    expect(title.endsWith("...")).toBe(true);
  });
});

describe("normalizeCliError", () => {
  it("detects 'Command not found' and includes CLI name in the message", () => {
    const error = normalizeCliError(
      "claude",
      "generateCommitMessage",
      new Error("Command not found: claude"),
      "Something went wrong",
    );

    expect(error).toBeInstanceOf(TextGenerationError);
    expect(error.detail).toContain("Claude CLI");
    expect(error.detail).toContain("not available on PATH");
  });

  it("uses the CLI name from the first argument for codex", () => {
    const error = normalizeCliError(
      "codex",
      "generateBranchName",
      new Error("Command not found: codex"),
      "Something went wrong",
    );

    expect(error).toBeInstanceOf(TextGenerationError);
    expect(error.detail).toContain("Codex CLI");
    expect(error.detail).toContain("not available on PATH");
  });

  it("returns the error as-is if it is already a TextGenerationError", () => {
    const existing = new TextGenerationError({
      operation: "generatePrContent",
      detail: "Already wrapped",
    });

    const result = normalizeCliError("claude", "generatePrContent", existing, "fallback");

    expect(result).toBe(existing);
  });

  it("wraps unknown non-Error values with the fallback message", () => {
    const result = normalizeCliError("codex", "generateCommitMessage", "string error", "fallback");

    expect(result).toBeInstanceOf(TextGenerationError);
    expect(result.detail).toBe("fallback");
  });

  it("does not expose CLI failure details in the public error message", () => {
    const result = normalizeCliError(
      "codex",
      "generateCommitMessage",
      new Error("request failed with access_token=secret-token"),
      "Failed to generate a commit message",
    );

    expect(result.detail).toBe("Failed to generate a commit message");
    expect(result.message).not.toContain("secret-token");
  });
});
