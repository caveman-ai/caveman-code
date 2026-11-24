// chat.search on a real SQLite journal: the chat where it happened is found even when it was mostly about
// something else, by words and (with an embedder) by meaning; restores, forks and secrets keep it honest.
import { createScrubber, type SessionEvent, type Workspace, type Session } from "@caveman-app/session-protocol";
import * as NodeSqliteClient from "@caveman-app/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { describe, expect, test } from "vitest";

import { ProjectSecrets } from "../secrets/ProjectSecrets.ts";
import type { DraftEvent } from "../session-protocol/projector.ts";
import * as Store from "../session-protocol/store.ts";
import { ChatSearch, layer as chatSearchLayer, make as makeChatSearch } from "./ChatSearch.ts";
import { Embedder, type EmbedderService } from "./Embedder.ts";

const SECRET = ("sk_" + "live_51HxYzAbCdEfGhIjKlMnOpQr");

/** A repository's secrets as ProjectSecretsLive hands them out: a new scrubber each time one is saved. */
const secretStore = (values: ReadonlyArray<string>) => {
  const saved = [...values];
  let scrubber = createScrubber(saved.map((value) => ({ name: "STRIPE_SECRET_KEY", value })));
  return {
    layer: Layer.succeed(
      ProjectSecrets,
      ProjectSecrets.of({
        keyOf: () => Effect.succeed("local:test"),
        repin: () => Effect.succeed("local:test"),
        list: () => Effect.succeed([]),
        set: () => Effect.die("unused"),
        remove: () => Effect.die("unused"),
        resolve: () => Effect.succeed([]),
        has: () => Effect.succeed(false),
        scrubber: Effect.sync(() => scrubber),
        changes: Stream.empty,
      } as unknown as ProjectSecrets["Service"]),
    ),
    /** A value saved as a secret now, after the chats that hold it were indexed. */
    save: (value: string) =>
      Effect.sync(() => {
        saved.push(value);
        scrubber = createScrubber(saved.map((v) => ({ name: "STRIPE_SECRET_KEY", value: v })));
      }),
  };
};

const secrets = (values: ReadonlyArray<string>) => secretStore(values).layer;

/**
 * Meaning, faked: a vector per topic, so "how do we charge customers" lands on the Stripe passage with no word in
 * common. Unit length, as the real model's.
 */
const TOPICS: ReadonlyArray<RegExp> = [/stripe|bill|payment|checkout|charge|subscription|invoice/i, /theme|colou?r|dark mode|toggle|setting/i, /worktree|branch|git|rebase/i];
const fakeEmbedder: EmbedderService = {
  model: "fake-topics",
  dimensions: TOPICS.length + 1,
  load: Effect.void,
  ready: () => true,
  isWord: () => false,
  embed: (texts) =>
    Effect.succeed(
      texts.map((text) => {
        const v = Float32Array.from([...TOPICS.map((t) => (t.test(text) ? 1 : 0)), 0.35]);
        const norm = Math.hypot(...v);
        return v.map((x) => x / norm);
      }),
    ),
};

const at = (minute: number) => new Date(Date.UTC(2026, 9, 17, 12, minute)).toISOString();

const workspace = (id: string, title: string, extra: Partial<Workspace> = {}) =>
  ({ id, session_id: `s-${id}`, title, status: "idle", created_at: at(0), updated_at: at(59), ...extra }) as unknown as Workspace;

const session = (id: string, extra: Partial<Session> = {}) => ({ id: `s-${id}`, workspace_id: id, head: 0, state: "live", created_at: at(0), updated_at: at(0), ...extra }) as unknown as Session;

const message = (role: "user" | "assistant", text: string, item: string): DraftEvent => ({ at: at(1), item_id: item, type: "message.done", payload: { role, text } }) as DraftEvent;

const run = <A>(
  body: (input: { search: ChatSearch["Service"]; store: Store.SessionStore["Service"]; save: (value: string) => Effect.Effect<void> }) => Effect.Effect<A, unknown>,
  options: { embedder?: EmbedderService; secrets?: ReadonlyArray<string> } = {},
) => {
  const repository = secretStore(options.secrets ?? []);
  return Effect.runPromise(
    Effect.gen(function* () {
      const search = yield* ChatSearch;
      const store = yield* Store.SessionStore;
      return yield* body({ search, store, save: repository.save });
    }).pipe(
      Effect.provide(chatSearchLayer.pipe(Layer.provideMerge(Store.layer), Layer.provide(repository.layer), Layer.provide(NodeSqliteClient.layer({ filename: ":memory:" })))),
      Effect.provideService(Embedder, options.embedder),
      Effect.scoped,
    ) as Effect.Effect<A>,
  );
};

const add = (store: Store.SessionStore["Service"], id: string, title: string, events: ReadonlyArray<DraftEvent>, extra: { workspace?: Partial<Workspace>; session?: Partial<Session> } = {}) =>
  Effect.gen(function* () {
    yield* store.putWorkspace({ workspace: workspace(id, title, extra.workspace), session: session(id, extra.session), internal: { threadId: `t-${id}`, worktreePath: null, repoPath: null } });
    if (events.length > 0) yield* store.append(`s-${id}`, () => Effect.succeed({ events, value: undefined }));
  });

/** Everything indexed and embedded, as the run loop would by now. */
const settle = (search: ChatSearch["Service"]) =>
  Effect.gen(function* () {
    yield* search.syncTitles;
    while ((yield* search.indexBatch) > 0);
    while ((yield* search.embedBatch) > 0);
  });

/** An event journaled raw, as one from before its value was saved as a secret. */
const journalRawEvent = <T extends SessionEvent["type"]>(store: Store.SessionStore["Service"], id: string, type: T, payload: Extract<SessionEvent, { type: T }>["payload"]) =>
  store.sql`INSERT INTO caveman_sp_events (session_id, cursor, type, at, event) VALUES (${`s-${id}`}, 1, ${type}, ${at(1)},
    ${JSON.stringify({ session_id: `s-${id}`, cursor: 1, at: at(1), item_id: `${id}1`, type, payload } as SessionEvent)})`;

const journalRaw = (store: Store.SessionStore["Service"], id: string, text: string) => journalRawEvent(store, id, "message.done", { role: "user", text });

/** Words, then the value with its first 25 characters before `cut`: where the index cuts a text that long. */
const across = (cut: number) => {
  const before = ` rotated STRIPE=${SECRET.slice(0, 25)}`;
  const text = `${"lorem ".repeat(cut).slice(0, cut - before.length)}${before}${SECRET.slice(25)} revoked`;
  expect(text.indexOf(SECRET) + 25).toBe(cut);
  return text;
};

/** What `texts` show of the value past its well-known prefix: any six characters of it. */
const leaked = (texts: ReadonlyArray<string>) =>
  Array.from({ length: SECRET.length - 13 }, (_, i) => SECRET.slice(8 + i, 14 + i)).filter((piece) => texts.some((text) => text.includes(piece)));

/** The settings chat that set up Stripe once, in its middle; a chat titled Stripe that is about themes; one about git. */
const seed = (store: Store.SessionStore["Service"]) =>
  Effect.gen(function* () {
    const settings: DraftEvent[] = [];
    for (let i = 0; i < 30; i++) {
      settings.push(message("user", `Set the settings page toggle ${i} to line up with the others`, `u${i}`));
      settings.push(message("assistant", `Done: the toggle ${i} on the settings page now lines up, spacing fixed in Settings.tsx.`, `a${i}`));
      if (i === 14) {
        settings.push(message("user", "Also set up Stripe so people can pay for the Team plan", "u-stripe"));
        settings.push(message("assistant", "I set up Stripe checkout in api/billing/checkout.ts and added the webhook that marks the subscription paid.", "a-stripe"));
        settings.push({ at: at(2), item_id: "t-stripe", type: "tool.started", payload: { name: "Bash", title: "pnpm add stripe", kind: "command", input: { command: "pnpm add stripe" } } } as DraftEvent);
      }
    }
    yield* add(store, "settings", "Settings polish", settings);
    yield* add(store, "stale", "Stripe Financial", [message("user", "Make the dark theme colours softer", "x1"), message("assistant", "The dark theme now uses softer greys.", "x2")]);
    yield* add(store, "git", "Worktree cleanup", [message("user", "Remove only the worktrees we created", "g1"), message("assistant", "The cleanup removes worktrees by exact name now.", "g2")]);
  });

describe("chat.search", () => {
  test("the run loop indexes and embeds a new message as it is journaled, with no poll in between", () => {
    let embedded = 0;
    const counting: EmbedderService = { ...fakeEmbedder, embed: (texts, as) => Effect.andThen(Effect.sync(() => (embedded += texts.length)), fakeEmbedder.embed(texts, as)) };
    return run(
      ({ search, store }) =>
        Effect.gen(function* () {
          yield* add(store, "billing", "Billing", [message("user", "the theme toggle", "u-theme")]);
          yield* Effect.forkScoped(search.run);
          const deadline = Date.now() + 5_000;
          const until = (done: () => Effect.Effect<boolean>) =>
            Effect.gen(function* () {
              while (!(yield* done())) {
                if (Date.now() > deadline) throw new Error("not indexed in time");
                yield* Effect.sleep("10 millis");
              }
            });
          yield* until(() => Effect.map(search.search("theme toggle"), (r) => !r.indexing && r.chats.length === 1));
          const before = embedded;
          const started = Date.now();
          yield* store.append("s-billing", () => Effect.succeed({ events: [message("user", "wire up the stripe checkout", "u-stripe")], value: undefined }));
          yield* until(() => Effect.map(search.search("stripe checkout"), (r) => r.chats.some((c) => c.passages.some((p) => p.item_id === "u-stripe"))));
          yield* until(() => Effect.succeed(embedded > before));
          // Well inside a second: woken by the event, not found by a poll.
          expect(Date.now() - started).toBeLessThan(900);
        }).pipe(Effect.scoped),
      { embedder: counting },
    );
  });

  test("a question finds the one place in a long chat about something else, marked, with its item", () =>
    run(({ search, store }) =>
      Effect.gen(function* () {
        yield* seed(store);
        yield* settle(search);
        const result = yield* search.search("where did i setup stripe functionality");
        expect(result.meaning).toBe("unavailable");
        expect(result.chats.map((c) => c.workspace.id)).toEqual(["settings", "stale"]);
        const [best] = result.chats[0]!.passages;
        expect(best).toMatchObject({ kind: "user", item_id: "u-stripe", by: "words" });
        expect(best!.marks.map((m) => best!.text.slice(m.start, m.end))).toEqual(["set up", "Stripe"]);
        // The other places in that chat follow it: the answer and the command.
        expect(result.chats[0]!.passages.map((p) => p.item_id)).toEqual(expect.arrayContaining(["a-stripe"]));
        // The stale title still matches, by its title, below.
        expect(result.chats[1]!.passages[0]).toMatchObject({ kind: "title", text: "Stripe Financial", cursor: 0 });
        expect(result.chats[1]!.passages[0]!.item_id).toBeUndefined();
      }),
    ));

  test("a typo is corrected and named; the word being typed matches as a prefix; nothing found is empty", () =>
    run(({ search, store }) =>
      Effect.gen(function* () {
        yield* seed(store);
        yield* settle(search);
        const typo = yield* search.search("stirpe checkout ");
        expect(typo.corrected).toBe("stripe checkout");
        expect(typo.chats[0]!.workspace.id).toBe("settings");
        expect((yield* search.search("webho")).chats[0]!.passages[0]!.item_id).toBe("a-stripe");
        expect((yield* search.search("kubernetes helm chart ")).chats).toEqual([]);
        expect((yield* search.search("   ")).chats).toEqual([]);
      }),
    ));

  test("by meaning: no word in common still finds it, and both ways at once is marked so", () =>
    run(
      ({ search, store }) =>
        Effect.gen(function* () {
          yield* seed(store);
          yield* settle(search);
          const result = yield* search.search("how do we charge customers");
          expect(result.meaning).toBe("ready");
          // The settings chat by its Stripe place, and the chat titled Stripe; never the git chat.
          expect(result.chats.map((c) => c.workspace.id).sort()).toEqual(["settings", "stale"]);
          const settings = result.chats.find((c) => c.workspace.id === "settings")!;
          expect(settings.passages[0]).toMatchObject({ by: "meaning", marks: [] });
          expect(["u-stripe", "a-stripe"]).toContain(settings.passages[0]!.item_id);
          const both = yield* search.search("stripe payments");
          expect(both.chats[0]!.workspace.id).toBe("settings");
          expect(both.chats[0]!.passages[0]!.by).toBe("both");
        }),
      { embedder: fakeEmbedder },
    ));

  test("a rename, a restore and a fork: the index says what the transcript says, once", () =>
    run(({ search, store }) =>
      Effect.gen(function* () {
        yield* add(store, "a", "Billing", [message("user", "add invoices for teams", "m1"), message("assistant", "Invoices added for teams.", "m2"), message("user", "now add refunds", "m3")]);
        yield* settle(search);
        expect((yield* search.search("refunds ")).chats).toHaveLength(1);
        // session.restore back to the second message: the refunds turn lives on in the branch only.
        yield* store.append("s-a", () => Effect.succeed({ events: [{ at: at(5), type: "session.restored", payload: { at: 2 } } as DraftEvent], value: undefined }));
        yield* settle(search);
        expect((yield* search.search("refunds ")).chats).toEqual([]);
        expect((yield* search.search("invoices ")).chats).toHaveLength(1);
        // A fork copies the prefix: its words are found in the source, not twice.
        yield* add(store, "fork", "Billing (fork)", [], { session: { forked_from: { session_id: "s-a", cursor: 2 } } });
        yield* store.sql`INSERT INTO caveman_sp_events (session_id, cursor, type, at, event) SELECT 's-fork', cursor, type, at, event FROM caveman_sp_events WHERE session_id = 's-a' AND cursor <= 2`;
        yield* settle(search);
        expect((yield* search.search("invoices ")).chats.map((c) => c.workspace.id)).toEqual(["a"]);
        // Titles follow renames.
        const record = (yield* store.getWorkspace("a"))!;
        yield* store.putWorkspace({ ...record, workspace: { ...record.workspace, title: "Refund policy" } });
        yield* search.syncTitles;
        expect((yield* search.search("refund policy ")).chats[0]!.passages[0]).toMatchObject({ kind: "title", text: "Refund policy" });
        expect((yield* search.search("billing ")).chats.map((c) => c.workspace.id)).toEqual(["fork"]);
      }),
    ));

  test("a secret stored before it was a secret never comes out in a snippet", () =>
    run(
      ({ search, store }) =>
        Effect.gen(function* () {
          yield* add(store, "k", "Keys", []);
          // Journaled raw, as an event from before the value was saved as a secret.
          yield* store.sql`INSERT INTO caveman_sp_events (session_id, cursor, type, at, event) VALUES ('s-k', 1, 'message.done', ${at(1)},
            ${JSON.stringify({ session_id: "s-k", cursor: 1, at: at(1), item_id: "k1", type: "message.done", payload: { role: "user", text: `my stripe key is ${SECRET}` } } satisfies SessionEvent)})`;
          yield* settle(search);
          const [chat] = (yield* search.search("stripe key")).chats;
          expect(chat!.passages[0]!.text).not.toContain(SECRET);
          expect(chat!.passages[0]!.text).toContain("[secret:STRIPE_SECRET_KEY]");
        }),
      { secrets: [SECRET] },
    ));

  test("a search for words inside a stored secret finds nothing; the words around it find it, masked", () =>
    run(
      ({ search, store }) =>
        Effect.gen(function* () {
          yield* add(store, "k", "Keys", []);
          yield* journalRaw(store, "k", `put STRIPE_KEY=${SECRET} into the env file`);
          yield* settle(search);
          // unicode61 splits sk_live_… at the underscores: a match there would confirm a guess at the value.
          expect((yield* search.search("sk_live ")).chats).toEqual([]);
          const [passage] = (yield* search.search("env file ")).chats[0]!.passages;
          expect(passage!.text).toBe("put STRIPE_KEY=[secret:STRIPE_SECRET_KEY] into the env file");
          expect(passage!.marks.map((m) => passage!.text.slice(m.start, m.end))).toEqual(["env", "file"]);
        }),
      { secrets: [SECRET] },
    ));

  test("a value saved as a secret after its chat was indexed answers no guess at it", () =>
    run(({ search, store, save }) =>
      Effect.gen(function* () {
        yield* add(store, "k", "Keys", []);
        const command = `curl -H 'Authorization: Bearer ${SECRET}' https://api.stripe.com/v1/charges`;
        yield* journalRawEvent(store, "k", "tool.started", { name: "Bash", title: command, kind: "command", input: { command } });
        yield* settle(search);
        const found = (query: string) => search.search(query).pipe(Effect.map((result) => result.chats.map((c) => c.workspace.id)));
        expect(yield* found("51hx")).toEqual(["k"]);
        yield* save(SECRET);
        // The word being typed matches as a prefix: a right guess at the next character and a wrong one answer alike.
        expect({ right: yield* found("51hxy"), wrong: yield* found("51hxz"), whole: yield* found(`${SECRET} `) }).toEqual({ right: [], wrong: [], whole: [] });
        // Nor is any word of it left in the index for a typo to be corrected to.
        const terms = (yield* store.sql<{ term: string }>`SELECT term FROM caveman_sp_search_terms`).map((t) => t.term);
        expect(terms.filter((term) => term.length >= 6 && SECRET.toLowerCase().includes(term))).toEqual([]);
        // Its other words still find it, the value masked.
        const [passage] = (yield* search.search("charges ")).chats[0]!.passages;
        expect(passage!.text).toContain("Bearer [secret:STRIPE_SECRET_KEY]");
      }),
    ));

  test("a value with emphasis marks in it, saved as a secret after its chat was indexed, never shows altered", () =>
    run(({ search, store, save }) =>
      Effect.gen(function* () {
        const value = "a8F__x9kQzRtYuP0";
        yield* add(store, "k", "Keys", []);
        // Read as markdown, the value's __ and __init__'s first __ are one emphasis: both pairs would go.
        yield* journalRaw(store, "k", `export KEY=${value} then call __init__ here`);
        yield* settle(search);
        yield* save(value);
        const [passage] = (yield* search.search("export ")).chats[0]!.passages;
        expect(passage!.text).toBe("export KEY=[secret:STRIPE_SECRET_KEY] then call init here");
      }),
    ));

  test("a passphrase saved as a secret after its chat was indexed shows no part of it, by words, a typo or meaning", () => {
    const embedded: string[] = [];
    const recording: EmbedderService = { ...fakeEmbedder, embed: (texts, kind) => (kind === "passage" && embedded.push(...texts), fakeEmbedder.embed(texts, kind)) };
    return run(
      ({ search, store, save }) =>
        Effect.gen(function* () {
          const value = "violet anchor quasar marmalade";
          // One sentence longer than a passage: the index cuts it at 900 characters, between the passphrase's words.
          const before = " rotated DB_PASS=violet anchor";
          const text = `${"lorem ".repeat(150).slice(0, 900 - before.length)}${before} quasar marmalade revoked`;
          expect(text.indexOf(" quasar")).toBe(900);
          // Journaled before it was a secret, so as it was written.
          yield* add(store, "k", "Keys", [message("user", "We moved the database password into the vault", "k0"), message("user", text, "k1")]);
          yield* settle(search);
          yield* save(value);
          const shown = (yield* search.search("rotated revoked ")).chats.flatMap((c) => c.passages.map((p) => p.text));
          expect(shown.length).toBeGreaterThan(0);
          expect(shown.filter((t) => /violet|anchor|quasar|marmalade/.test(t))).toEqual([]);
          const typo = yield* search.search("marmelade ");
          expect({ corrected: typo.corrected, chats: typo.chats.length }).toEqual({ corrected: undefined, chats: 0 });
          // Only the passage embedded with half of it in it is embedded again, from what it holds now; the other half
          // (a mask and one word) is too short to be read by meaning, and the chat's other passages keep their vectors.
          embedded.length = 0;
          yield* settle(search);
          expect(embedded).toEqual([expect.stringMatching(/lorem rotated$/)]);
        }),
      { embedder: recording },
    );
  });

  test("a chat read again for a newly saved secret still says what its transcript says: restores and forks hold", () =>
    run(({ search, store, save }) =>
      Effect.gen(function* () {
        yield* add(store, "a", "Billing", [message("user", `add invoices for teams, key ${SECRET}`, "m1"), message("assistant", "Invoices added for teams.", "m2"), message("user", `now add refunds with ${SECRET}`, "m3")]);
        // Back to the second message: the refunds turn lives on in the branch only.
        yield* store.append("s-a", () => Effect.succeed({ events: [{ at: at(5), type: "session.restored", payload: { at: 2 } } as DraftEvent], value: undefined }));
        yield* add(store, "fork", "Billing (fork)", [], { session: { forked_from: { session_id: "s-a", cursor: 2 } } });
        yield* store.sql`INSERT INTO caveman_sp_events (session_id, cursor, type, at, event) SELECT 's-fork', cursor, type, at, event FROM caveman_sp_events WHERE session_id = 's-a' AND cursor <= 2`;
        yield* settle(search);
        yield* save(SECRET);
        expect((yield* search.search("refunds ")).chats).toEqual([]);
        const invoices = yield* search.search("invoices ");
        expect(invoices.chats.map((c) => c.workspace.id)).toEqual(["a"]);
        expect(invoices.chats[0]!.passages.map((p) => p.text).sort()).toEqual(["Invoices added for teams.", "add invoices for teams, key [secret:STRIPE_SECRET_KEY]"]);
      }),
    ));

  test("a snippet whose window starts inside a stored secret shows none of it", () =>
    run(
      ({ search, store }) =>
        Effect.gen(function* () {
          yield* add(store, "k", "Keys", []);
          // FTS5's 28-token window ending at "rotated" starts at "live", the middle of the value.
          const words = (n: number, w: string) => Array.from({ length: n }, (_, i) => `${w}${i}`).join(" ");
          yield* journalRaw(store, "k", `${words(30, "a")} key ${SECRET} ${words(25, "b")} rotated`);
          yield* settle(search);
          const [passage] = (yield* search.search("rotated ")).chats[0]!.passages;
          expect(passage!.text).not.toContain(SECRET.slice(SECRET.indexOf("51")));
          expect(passage!.text.startsWith("…[secret:STRIPE_SECRET_KEY] b0 b1")).toBe(true);
          expect(passage!.marks.map((m) => passage!.text.slice(m.start, m.end))).toEqual(["rotated"]);
        }),
      { secrets: [SECRET] },
    ));

  test("a passage found by meaning, cut to length across a stored secret, shows none of it", () =>
    run(
      ({ search, store }) =>
        Effect.gen(function* () {
          yield* seed(store);
          yield* add(store, "k", "Keys", []);
          const lead = "Billing notes for the Team plan. ";
          // The value straddles the 240th character, where a passage found only by meaning is cut.
          const text = `${lead}${"rollout ".repeat(24)}${SECRET} is live now`;
          expect(text.indexOf(SECRET)).toBe(225);
          yield* journalRaw(store, "k", text);
          yield* settle(search);
          const keys = (yield* search.search("how do we charge customers")).chats.find((c) => c.workspace.id === "k");
          expect(keys!.passages[0]!.by).toBe("meaning");
          expect(keys!.passages[0]!.text).not.toContain(SECRET.slice(0, 12));
        }),
      { embedder: fakeEmbedder, secrets: [SECRET] },
    ));

  test("a stored secret where the index cut a passage to length shows none of it", () =>
    run(
      ({ search, store }) =>
        Effect.gen(function* () {
          const sites = {
            // A sentence longer than a passage.
            message: () => journalRawEvent(store, "message", "message.done", { role: "user", text: across(900) }),
            title: () => journalRawEvent(store, "title", "tool.started", { name: "Bash", title: across(600), kind: "command", input: {} }),
            inputs: () => journalRawEvent(store, "inputs", "tool.started", { name: "Bash", title: "", kind: "command", input: { command: across(600) } }),
            paths: () => journalRawEvent(store, "paths", "tool.started", { name: "Read", title: "", kind: "read", input: { paths: [across(500), "src/other.ts"] } }),
            plan: () => journalRawEvent(store, "plan", "plan.updated", { kind: "todos", steps: [{ text: across(2_000), status: "pending" }] }),
            ask: () =>
              journalRawEvent(store, "ask", "ask.user", { kind: "question", questions: [{ id: "q", prompt: across(2_000), options: [], multi_select: false, allow_text: true }] }),
            files: () => journalRawEvent(store, "files", "diff.changed", { files: [{ path: across(4_000), status: "added", additions: 1, deletions: 0 }] }),
          };
          for (const [id, journal] of Object.entries(sites)) {
            yield* add(store, id, "Keys", []);
            yield* journal();
          }
          yield* settle(search);
          const shown = new Map<string, string[]>();
          for (const query of ["rotated ", "revoked "]) {
            for (const chat of (yield* search.search(query)).chats) shown.set(chat.workspace.id, [...(shown.get(chat.workspace.id) ?? []), ...chat.passages.map((p) => p.text)]);
          }
          expect([...shown.keys()].sort()).toEqual(Object.keys(sites).sort());
          expect(Object.fromEntries([...shown].map(([id, texts]) => [id, leaked(texts)]))).toEqual(Object.fromEntries(Object.keys(sites).map((id) => [id, []])));
        }),
      { secrets: [SECRET] },
    ));

  test("an index whose passages were cut through words is built again from the journal", () =>
    run(
      ({ search, store }) =>
        Effect.gen(function* () {
          yield* add(store, "k", "Keys", []);
          const text = across(900);
          yield* journalRaw(store, "k", text);
          yield* settle(search);
          // As the first version of the index left it: cut at 900 characters, through the value.
          for (const [i, piece] of [text.slice(0, 900), text.slice(900)].entries()) {
            yield* store.sql`UPDATE caveman_sp_search SET text = ${piece} WHERE rowid = (SELECT id FROM caveman_sp_search_rows WHERE key = ${`k1#${i}`})`;
          }
          yield* store.kvSet("search.version", "1");
          const restarted = yield* makeChatSearch.pipe(Effect.provide(secrets([SECRET])), Effect.provideService(Store.SessionStore, store));
          yield* settle(restarted);
          const texts = (yield* restarted.search("revoked ")).chats.flatMap((chat) => chat.passages.map((p) => p.text));
          expect(texts).toHaveLength(1);
          expect(leaked(texts)).toEqual([]);
        }),
      { secrets: [SECRET] },
    ));

  test("a typo of a word whose stem is no word finds the chat and names the word ('databse' -> 'database')", () =>
    run(({ search, store }) =>
      Effect.gen(function* () {
        yield* add(store, "db", "Migration", [message("user", "We migrated the database to postgres", "d1")]);
        yield* add(store, "ship", "Pipeline", [message("user", "Both deployments now ship on tag", "p1")]);
        yield* add(store, "again", "Friday", [message("user", "The deployment ran again on Friday", "f1")]);
        yield* settle(search);
        // The index holds porter stems ("databas", "deploy"); searched again, a stem is stemmed again ("databa", "deploi").
        const database = yield* search.search("databse ");
        expect({ corrected: database.corrected, chats: database.chats.map((c) => c.workspace.id) }).toEqual({ corrected: "database", chats: ["db"] });
        // Of the words the chats wrote with that stem, the one nearest what was typed names it, not the first found.
        const deployment = yield* search.search("deplyo ");
        expect({ corrected: deployment.corrected, chats: deployment.chats.map((c) => c.workspace.id).sort() }).toEqual({ corrected: "deployment", chats: ["again", "ship"] });
      }),
    ));
});
