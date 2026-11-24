// What the phone holds of the person's pull requests (store.ts) against a stand-in Cloud: the list as it is read, a
// pull request as it opens, each change sent once and read back, what a refusal leaves behind, and that nothing of
// one person's shows to the next.
import { describe, expect, it } from "vitest";

import { listView, pullKey } from "./model";
import { createPulls } from "./store";
import { detail, HEAD, NOW, PRS, refusal, standIn } from "./testing";

const ADA = "ada@example.com";
const KEY = pullKey("acme/api", 7);

function setup(start?: Parameters<typeof standIn>[0], retryMs: ReadonlyArray<number> = []) {
  const stage = standIn(start);
  const said: string[] = [];
  const pulls = createPulls({
    cloud: async () => stage.cloud,
    say: (text) => void said.push(text),
    now: () => NOW,
    retryMs,
  });
  return { ...stage, said, pulls, pull: () => pulls.store.get().pulls[KEY]! };
}

describe("the list", () => {
  it("is read when asked for, and says Loading only until its first answer", async () => {
    const { pulls, named } = setup();
    const reading = pulls.readList(ADA);
    expect(listView(pulls.store.get())).toEqual({ kind: "loading" });
    await reading;
    expect(named("reviews")).toHaveLength(1);
    expect(pulls.store.get().list?.prs).toBe(PRS);
    const again = pulls.readList(ADA);
    expect(listView(pulls.store.get()).kind).toBe("rows");
    await again;
    expect(named("reviews")).toHaveLength(2);
  });

  it("is read once for everyone who asks while it is out", async () => {
    const { pulls, named } = setup();
    await Promise.all([pulls.readList(ADA), pulls.readList(ADA)]);
    expect(named("reviews")).toHaveLength(1);
  });

  it("works out where GitHub connects, relative to Cloud itself", async () => {
    const { pulls } = setup({
      list: { prs: [], errors: [], github: "not_connected", connect_url: "/cave-agent/code" },
    });
    await pulls.readList(ADA);
    expect(listView(pulls.store.get())).toEqual({
      kind: "connect",
      url: "https://cloud.test/cave-agent/code",
    });
  });

  it("reads a refusal for want of a GitHub link as the same one thing to do", async () => {
    const { pulls, fail } = setup();
    fail("reviews", refusal.notConnected("/cave-agent/code?next=review"));
    await pulls.readList(ADA);
    expect(listView(pulls.store.get())).toEqual({
      kind: "connect",
      url: "https://cloud.test/cave-agent/code?next=review",
    });
  });

  it("draws nothing where this Caveman serves no Review to a phone", async () => {
    const { pulls } = setup({ list: null });
    await pulls.readList(ADA);
    expect(listView(pulls.store.get())).toEqual({ kind: "none" });
  });

  it("is read again by itself when what failed passes by itself, and says nothing meanwhile", async () => {
    const { pulls, fail, named } = setup(undefined, [1, 1]);
    fail("reviews", refusal.offline());
    await pulls.readList(ADA);
    expect(named("reviews")).toHaveLength(2);
    expect(pulls.store.get().problem).toBeNull();
    expect(listView(pulls.store.get()).kind).toBe("rows");
  });

  it("says why once it still cannot be read, and keeps what it read before", async () => {
    const { pulls, fail } = setup(undefined, [1]);
    fail("reviews", refusal.offline(), true);
    await pulls.readList(ADA);
    expect(listView(pulls.store.get())).toEqual({
      kind: "problem",
      words: "No network. Pull requests load when you're back online.",
    });

    const kept = setup();
    await kept.pulls.readList(ADA);
    kept.fail("reviews", refusal.busy(), true);
    await kept.pulls.readList(ADA);
    expect(listView(kept.pulls.store.get()).kind).toBe("rows");
  });

  it("is not asked for twice over what will not pass", async () => {
    const { pulls, fail, named } = setup(undefined, [1, 1]);
    fail("reviews", refusal.notFound(), true);
    await pulls.readList(ADA);
    expect(named("reviews")).toHaveLength(1);
  });
});

describe("a pull request", () => {
  it("is read with its discussion as it opens; its patches only once a file is opened", async () => {
    const { pulls, pull, named, calls } = setup();
    const opening = pulls.open(ADA, "acme/api", 7);
    expect(pull().reading).toBe(true);
    await opening;
    expect(calls.map((c) => c.call).sort()).toEqual(["pull", "pullDiscussion"]);
    expect(named("pull")[0]?.args).toEqual(["acme/api", 7]);
    expect(pull()).toMatchObject({ reading: false, problem: null, diff: null });
    expect(pull().detail?.title).toBe("Stop the login redirect loop");
    expect(pull().discussion).toHaveLength(3);

    await pulls.readDiff("acme/api", 7);
    await pulls.readDiff("acme/api", 7);
    expect(named("pullDiff")).toHaveLength(1);
    expect(pull().diff?.files.map((f) => f.path)).toEqual(["src/auth/login.ts"]);
  });

  it("says why it could not be read, with where GitHub connects when that is why", async () => {
    const lost = setup();
    lost.fail("pull", refusal.notFound());
    await lost.pulls.open(ADA, "acme/api", 7);
    expect(lost.pull()).toMatchObject({
      detail: null,
      reading: false,
      problem: { words: "Can't find this pull request in your projects." },
    });
    expect(lost.pull().problem?.connect).toBeUndefined();

    const unlinked = setup();
    unlinked.fail("pull", refusal.notConnected());
    await unlinked.pulls.open(ADA, "acme/api", 7);
    expect(unlinked.pull().problem).toEqual({
      words: "Connect GitHub to review pull requests here.",
      connect: "https://cloud.test/cave-agent/code",
    });
  });

  it("shows the pull request even when its discussion could not be read", async () => {
    const { pulls, pull, fail } = setup();
    fail("pullDiscussion", refusal.busy());
    await pulls.open(ADA, "acme/api", 7);
    expect(pull().detail).not.toBeNull();
    expect(pull()).toMatchObject({
      discussion: null,
      discussionProblem: "Couldn't load the discussion.",
    });
  });

  it("drops the patches it read once the head has moved", async () => {
    const { pulls, pull, held } = setup();
    await pulls.open(ADA, "acme/api", 7);
    await pulls.readDiff("acme/api", 7);
    await pulls.open(ADA, "acme/api", 7);
    expect(pull().diff).not.toBeNull();
    held.detail = detail({ head_sha: "f".repeat(40) });
    await pulls.open(ADA, "acme/api", 7);
    expect(pull().diff).toBeNull();
  });
});

describe("a change", () => {
  it("approves, reads the pull request again, then says so", async () => {
    const { pulls, pull, named, said } = setup();
    await pulls.open(ADA, "acme/api", 7);
    const approving = pulls.approve("acme/api", 7);
    expect(pull().busy).toEqual({ change: "approve", since: NOW });
    expect(said).toEqual([]);
    expect(await approving).toBe(true);
    expect(named("reviewPull")[0]?.args).toEqual(["acme/api", 7, { verdict: "approve" }]);
    expect(named("pull")).toHaveLength(2);
    expect(named("pullDiscussion")).toHaveLength(2);
    expect(pull().busy).toBeNull();
    expect(said).toEqual(["Approved"]);
  });

  it("asks for changes with what was typed, trimmed, and never without it", async () => {
    const { pulls, named, said } = setup();
    await pulls.open(ADA, "acme/api", 7);
    expect(await pulls.requestChanges("acme/api", 7, "   ")).toBe(false);
    expect(named("reviewPull")).toHaveLength(0);
    expect(await pulls.requestChanges("acme/api", 7, "  Check the expiry first.\n")).toBe(true);
    expect(named("reviewPull")[0]?.args).toEqual([
      "acme/api",
      7,
      { verdict: "request_changes", body: "Check the expiry first." },
    ]);
    expect(said).toEqual(["Changes requested"]);
  });

  it("comments on the pull request", async () => {
    const { pulls, named, said } = setup();
    await pulls.open(ADA, "acme/api", 7);
    expect(await pulls.comment("acme/api", 7, "Thanks for this.")).toBe(true);
    expect(named("commentOnPull")[0]?.args).toEqual(["acme/api", 7, { body: "Thanks for this." }]);
    expect(await pulls.comment("acme/api", 7, "")).toBe(false);
    expect(named("commentOnPull")).toHaveLength(1);
    expect(said).toEqual(["Commented"]);
  });

  it("merges by the repository's first method, with the head it was read at, and reads it merged", async () => {
    const { pulls, pull, named, said } = setup();
    await pulls.open(ADA, "acme/api", 7);
    expect(await pulls.merge("acme/api", 7)).toBe(true);
    expect(named("mergePull")[0]?.args).toEqual([
      "acme/api",
      7,
      { method: "squash", head_sha: HEAD },
    ]);
    expect(pull().detail).toMatchObject({ state: "merged", can: { merge: false, review: false } });
    expect(said).toEqual(["Merged"]);
    // Merged, there is nothing left to merge: Cloud is not asked.
    expect(await pulls.merge("acme/api", 7)).toBe(false);
    expect(named("mergePull")).toHaveLength(1);
  });

  it("reads a merged pull request as merged even when the read after it fails", async () => {
    const { pulls, pull, fail } = setup();
    await pulls.open(ADA, "acme/api", 7);
    fail("pull", refusal.busy(), true);
    expect(await pulls.merge("acme/api", 7)).toBe(true);
    expect(pull().detail).toMatchObject({ state: "merged", can: { merge: false, review: false } });
    expect(pull().busy).toBeNull();
  });

  it("asks Cloud for no merge GitHub would refuse: conflicts, a draft, or no right to", async () => {
    for (const over of [
      { mergeable: "conflicting" as const },
      { state: "draft" as const },
      { can: { ...detail().can, merge: false } },
    ]) {
      const { pulls, named } = setup({ detail: detail(over) });
      await pulls.open(ADA, "acme/api", 7);
      expect(await pulls.merge("acme/api", 7)).toBe(false);
      expect(named("mergePull")).toHaveLength(0);
    }
  });

  it("says GitHub's own words when GitHub refuses, says nothing in the toast, and is not sent again", async () => {
    const { pulls, pull, fail, named, said } = setup(undefined, [1, 1]);
    await pulls.open(ADA, "acme/api", 7);
    fail(
      "mergePull",
      refusal.github("At least 1 approving review is required by reviewers with write access."),
    );
    expect(await pulls.merge("acme/api", 7)).toBe(false);
    expect(pull().refused).toEqual({
      change: "merge",
      words: "At least 1 approving review is required by reviewers with write access.",
    });
    expect(pull().busy).toBeNull();
    expect(named("mergePull")).toHaveLength(1);
    expect(named("pull")).toHaveLength(1);
    expect(said).toEqual([]);
  });

  it("is sent once even when nothing was reached: an approval that may have arrived is never sent twice", async () => {
    const { pulls, pull, fail, named } = setup(undefined, [1, 1]);
    await pulls.open(ADA, "acme/api", 7);
    fail("reviewPull", refusal.offline(), true);
    expect(await pulls.approve("acme/api", 7)).toBe(false);
    expect(named("reviewPull")).toHaveLength(1);
    expect(pull().refused).toEqual({ change: "approve", words: "No network. Not approved." });
  });

  it("answers false when a comment is refused, so what was typed stays where it was typed", async () => {
    const { pulls, pull, fail, said } = setup();
    await pulls.open(ADA, "acme/api", 7);
    fail("commentOnPull", refusal.notConnected());
    expect(await pulls.comment("acme/api", 7, "Half a thought")).toBe(false);
    expect(pull().refused).toEqual({
      change: "comment",
      words: "Connect GitHub to review pull requests here.",
      connect: "https://cloud.test/cave-agent/code",
    });
    expect(said).toEqual([]);
    // The next try clears what the last one said.
    const again = pulls.comment("acme/api", 7, "Half a thought");
    expect(pull().refused).toBeNull();
    expect(await again).toBe(true);
  });

  it("lets nothing else be sent while one is on its way", async () => {
    const { pulls, named } = setup();
    await pulls.open(ADA, "acme/api", 7);
    const first = pulls.approve("acme/api", 7);
    expect(await pulls.approve("acme/api", 7)).toBe(false);
    expect(await pulls.comment("acme/api", 7, "Also this")).toBe(false);
    await first;
    expect(named("reviewPull")).toHaveLength(1);
    expect(named("commentOnPull")).toHaveLength(0);
  });
});

describe("another person", () => {
  it("starts from nothing: no list and no pull request of whoever was signed in before", async () => {
    const { pulls } = setup();
    await pulls.readList(ADA);
    await pulls.open(ADA, "acme/api", 7);
    const reading = pulls.readList("bob@example.com");
    expect(pulls.store.get()).toMatchObject({ person: "bob@example.com", list: null, pulls: {} });
    await reading;
    expect(pulls.store.get().list?.prs).toBe(PRS);
  });

  it("is never shown an answer that was on its way for the last one", async () => {
    const { pulls, cloud } = setup();
    const theirs = { prs: [PRS[2]!], errors: [], github: "connected" as const };
    const answers: Array<
      (list: typeof theirs | { prs: typeof PRS; errors: []; github: "connected" }) => void
    > = [];
    cloud.reviews = () => new Promise((resolve) => void answers.push(resolve));
    const first = pulls.readList(ADA);
    const second = pulls.readList("bob@example.com");
    while (answers.length < 2) await new Promise((resolve) => setTimeout(resolve, 1));
    // Bob's answer comes first, then the one that was on its way for Ada.
    answers[1]!(theirs);
    await second;
    answers[0]!({ prs: PRS, errors: [], github: "connected" });
    await first;
    expect(pulls.store.get()).toMatchObject({ person: "bob@example.com", reading: false });
    expect(pulls.store.get().list?.prs).toBe(theirs.prs);
  });
});
