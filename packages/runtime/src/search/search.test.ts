import type { SessionEvent } from "@caveman-app/session-protocol";
import { describe, expect, test } from "vitest";

import { marked } from "./ChatSearch.ts";
import { chunks, identifierParts, passagesOf, plain, upTo } from "./passages.ts";
import { anyFts, correction, editDistance, groupFts, parseQuery } from "./query.ts";
import { basicTokens, wordPiece } from "./wordpiece.ts";

describe("wordpiece", () => {
  // Ids are line numbers, as in the model's vocab.txt.
  const vocab = ["[PAD]", "[UNK]", "[CLS]", "[SEP]", "stripe", "check", "##out", "'", "s", ",", "un", "##aff", "##able", "cafe"].join("\n");
  const tokenizer = wordPiece(vocab);

  test("lower-cases, strips accents, splits punctuation as BERT does", () => {
    expect(basicTokens("Stripe's Café, NOW!")).toEqual(["stripe", "'", "s", "cafe", ",", "now", "!"]);
    expect(basicTokens("a_b $5 日本")).toEqual(["a", "_", "b", "$", "5", "日", "本"]);
  });

  test("greedy longest match, ## continuations, [UNK] for a word with an unknown rest, [CLS]/[SEP] around", () => {
    expect(tokenizer.encode("Checkout Stripe's", 32)).toEqual([2, 5, 6, 4, 7, 8, 3]);
    expect(tokenizer.encode("unaffable café", 32)).toEqual([2, 10, 11, 12, 13, 3]);
    expect(tokenizer.encode("zebra", 32)).toEqual([2, 1, 3]);
    // Capped with [SEP] kept last.
    expect(tokenizer.encode("stripe stripe stripe stripe", 4)).toEqual([2, 4, 4, 3]);
  });
});

describe("query", () => {
  const labels = (q: string) => parseQuery(q).map((g) => g.label);

  test("a question keeps only what it is about", () => {
    expect(labels("where did i setup stripe functionality")).toEqual(["setup", "stripe"]);
    expect(labels("stripe webhook signature")).toEqual(["stripe", "webhook", "signature"]);
    expect(labels("What did we talk about the webhook in that chat last week?")).toEqual(["webhook"]);
  });

  test("setup also finds set up, and set up also finds setup", () => {
    const [setup] = parseQuery("setup stripe ");
    expect(setup!.alternatives.map((a) => a.words)).toEqual([["setup"], ["set", "up"]]);
    const [setUp] = parseQuery("how did I set up stripe ");
    expect(setUp!.label).toBe("set");
    expect(setUp!.alternatives.map((a) => a.words)).toEqual([["set", "up"], ["setup"], ["set"]]);
    expect(groupFts(setUp!)).toBe('("set up" OR "setup" OR "set")');
  });

  test("the word being typed is a prefix; quoted text is one phrase", () => {
    expect(anyFts(parseQuery("stripe check"))).toBe('"stripe" OR "check" *');
    expect(anyFts(parseQuery('"billing portal" error '))).toBe('"billing portal" OR "error"');
    // Quotes in a word cannot break the expression.
    expect(groupFts({ label: "x", alternatives: [{ words: ['a"b'], prefix: false }] })).toBe('"a""b"');
  });

  test("only stop words: searched as typed", () => {
    expect(labels("how did we do it ")).toEqual(["how", "did", "we", "do", "it"]);
  });

  test("typos: nearest indexed word within budget, ties to the commonest", () => {
    expect(editDistance("stirpe", "stripe", 2)).toBe(1);
    expect(editDistance("paymnets", "payment", 2)).toBe(2);
    expect(editDistance("abc", "xyzzy", 1)).toBe(2);
    const terms = [
      { term: "stripe", doc: 40 },
      { term: "strike", doc: 3 },
      { term: "string", doc: 90 },
    ];
    expect(correction("stirpe", terms)).toBe("stripe");
    expect(correction("strie", terms)).toBe("stripe");
    // Too short to guess at.
    expect(correction("stp", terms)).toBeUndefined();
  });
});

describe("passages", () => {
  const event = (type: string, payload: unknown, extra: Partial<SessionEvent> = {}) =>
    ({ session_id: "s", cursor: 7, at: "2026-10-18T00:00:00Z", type, payload, ...extra }) as SessionEvent;

  test("a long answer is several passages, cut between paragraphs, all pointing at its item", () => {
    const long = Array.from({ length: 12 }, (_, i) => `Paragraph ${i} ${"about settings and toggles ".repeat(6)}`).join("\n\n");
    const out = passagesOf(event("message.done", { role: "assistant", text: `${long}\n\nThen I set up **Stripe** checkout.` }, { item_id: "msg-1" }));
    expect(out.length).toBeGreaterThanOrEqual(3);
    expect(new Set(out.map((p) => p.item))).toEqual(new Set(["msg-1"]));
    expect(out.every((p) => p.text.length <= 900)).toBe(true);
    expect(out.at(-1)!.text).toContain("Then I set up Stripe checkout.");
    expect(new Set(out.map((p) => p.key)).size).toBe(out.length);
  });

  test("cut to length only between words: a word longer than the length stays whole", () => {
    expect(upTo("alpha beta gamma", 12)).toBe("alpha beta");
    expect(upTo("alpha beta gamma", 10)).toBe("alpha beta");
    expect(upTo("alphabetagamma delta", 5)).toBe("alphabetagamma");
    expect(upTo("alphabetagamma", 5)).toBe("alphabetagamma");
    expect(upTo("alpha  beta", 8)).toBe("alpha");
    expect(upTo("  alphabeta gamma", 5)).toBe("  alphabeta");
    const sentence = Array.from({ length: 300 }, (_, i) => `word${i}`).join(" ");
    const pieces = chunks(sentence);
    expect(pieces.length).toBeGreaterThan(1);
    expect(pieces.every((p) => p.length <= 900)).toBe(true);
    expect(pieces.join(" ")).toBe(sentence);
    expect(chunks(`${"x".repeat(1_000)} tail`)).toEqual(["x".repeat(1_000), "tail"]);
    const files = Array.from({ length: 400 }, (_, i) => ({ path: `src/feature${i}/index.ts`, status: "added", additions: 1, deletions: 0 }));
    const [listed] = passagesOf(event("diff.changed", { files }));
    expect(listed!.text.length).toBeLessThanOrEqual(4_000);
    expect(listed!.text.split(" · ").every((path, i) => path === files[i]!.path)).toBe(true);
  });

  test("the person's words, an agent's message, a command with its inputs, files, a question; not approvals or deltas", () => {
    expect(passagesOf(event("message.done", { role: "user", text: "add stripe" }))[0]).toMatchObject({ kind: "user", item: "message.done:7" });
    expect(passagesOf(event("message.done", { role: "user", text: "do this", from: { title: "Chief" } }))[0]!.kind).toBe("assistant");
    const [tool] = passagesOf(event("tool.started", { name: "Bash", title: "pnpm add stripe", kind: "command", input: { command: "pnpm add stripe", content: "SECRET FILE BODY" } }, { item_id: "t1" }));
    expect(tool).toMatchObject({ kind: "tool", item: "t1", text: "pnpm add stripe", embed: false });
    expect(tool!.aux).not.toContain("SECRET FILE BODY");
    expect(passagesOf(event("diff.changed", { files: [{ path: "src/lib/stripeClient.ts", status: "added", additions: 1, deletions: 0 }] }))[0]).toMatchObject({ key: "files", kind: "files", text: "src/lib/stripeClient.ts" });
    expect(passagesOf(event("diff.changed", { files: [] }))[0]!.text).toBe("");
    expect(passagesOf(event("ask.user", { kind: "question", questions: [{ id: "q", prompt: "Which billing provider?", options: [{ id: "a", label: "Stripe" }], multi_select: false, allow_text: true }] }))[0]).toMatchObject({ kind: "ask", text: "Which billing provider? Stripe" });
    expect(passagesOf(event("ask.user", { kind: "approval", title: "rm -rf", options: [] }))).toEqual([]);
    expect(passagesOf(event("message.delta", { text: "stripe" }))).toEqual([]);
  });

  test("identifiers in parts, markdown as it reads, the snippet markers never kept", () => {
    expect(identifierParts("useStripeCheckout and parseHTTPResponse, not STRIPE or plain")).toBe("use stripe checkout parse http response");
    expect(plain("## Done\n- [x] **Stripe** [docs](https://x.y)\n```ts\nconst a = 1\n```")).toBe("Done\nStripe docs\n\nconst a = 1");
    expect(chunks("a\u0001b")).toEqual(["a\u0001b"]);
    expect(passagesOf(event("message.done", { role: "user", text: "a\u0001b\u0002 c d" }))[0]!.text).toBe("ab c d");
  });
});

test("marked: the snippet's markers become ranges, cut from the passage scrubbed whole", () => {
  const scrub = (t: string) => t.replaceAll("sk_live_1", "[secret:KEY]");
  const passage = "Then I set up Stripe with sk_live_1 and moved on to the settings page";
  // FTS5's window has no ellipses: they go back where it was cut.
  expect(marked(passage, "I set \u0001up\u0002 \u0001Stripe\u0002 with sk_live_1", scrub)).toEqual({
    text: "…I set up Stripe with [secret:KEY]…",
    marks: [
      { start: 7, end: 9 },
      { start: 10, end: 16 },
    ],
  });
  // A match inside the value and the window's edge inside it: all of the value goes, the mark is on what replaced it.
  expect(marked(passage, "Stripe with sk_\u0001live\u0002", scrub)).toEqual({ text: "…Stripe with [secret:KEY]…", marks: [{ start: 13, end: 25 }] });
  // No snippet: the passage's start.
  expect(marked(passage, undefined, scrub)).toEqual({ text: "Then I set up Stripe with [secret:KEY] and moved on to the settings page", marks: [] });
});
