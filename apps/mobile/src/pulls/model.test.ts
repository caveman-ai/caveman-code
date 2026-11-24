// Which pull requests the Needs you list holds and in which group (the web's queue model), what the list draws in
// each state, which changes a pull request's foot offers, and where "Connect GitHub" opens.
import { describe, expect, it } from "vitest";

import {
  canMerge,
  connectUrl,
  footOf,
  groupOf,
  listView,
  mergeMethod,
  NO_PULLS,
  pullKey,
  waitingGroups,
  waitingOnReview,
} from "./model";
import { detail, PRS, summary } from "./testing";

const numbers = (prs: ReadonlyArray<{ number: number }>) => prs.map((pr) => pr.number);

describe("the list's groups", () => {
  it("puts a pull request in the web's group for it, first match first", () => {
    expect(PRS.map(groupOf)).toEqual(["needs_you", "needs_you", "yours", "drafts", "others"]);
    // A draft that asks for the person's review is a draft; their own with a review asked of them is theirs.
    expect(
      groupOf(
        summary({ number: 1, title: "t", repo: "a/b", state: "draft", review_requested: true }),
      ),
    ).toBe("drafts");
    expect(
      groupOf(summary({ number: 1, title: "t", repo: "a/b", mine: true, review_requested: true })),
    ).toBe("yours");
    expect(
      groupOf(summary({ number: 1, title: "t", repo: "a/b", state: "merged", mine: true })),
    ).toBe("closed");
  });

  it("holds what waits on the person's review, then their own open ones, in the order Cloud sent them", () => {
    const groups = waitingGroups(PRS);
    expect(groups.map((g) => g.id)).toEqual(["needs_you", "yours"]);
    expect(numbers(groups[0]!.prs)).toEqual([7, 12]);
    expect(numbers(groups[1]!.prs)).toEqual([8]);
  });

  it("leaves out drafts, everyone else's open pull requests, and a group with nothing in it", () => {
    expect(waitingGroups(PRS.filter((pr) => pr.number === 31 || pr.number === 40))).toEqual([]);
    expect(waitingGroups(PRS.filter((pr) => pr.mine)).map((g) => g.id)).toEqual(["yours"]);
  });

  it("counts what waits on the person's review", () => {
    expect(waitingOnReview(PRS)).toBe(2);
    expect(waitingOnReview([])).toBe(0);
  });
});

describe("what the Needs you list draws of pull requests", () => {
  const read = { reading: false, problem: null };

  it("draws nothing before it was asked for, or where this Caveman serves no Review to a phone", () => {
    expect(listView({ list: null, ...read })).toBe(NO_PULLS);
  });

  it("says Loading while it is read for the first time, and keeps what it has while it is read again", () => {
    expect(listView({ list: null, reading: true, problem: null })).toEqual({ kind: "loading" });
    expect(
      listView({ list: { prs: PRS, errors: [], connect: null }, reading: true, problem: null })
        .kind,
    ).toBe("rows");
  });

  it("says why it could not be read while there is nothing older to show", () => {
    expect(
      listView({ list: null, reading: false, problem: "Couldn't load pull requests." }),
    ).toEqual({ kind: "problem", words: "Couldn't load pull requests." });
    expect(
      listView({
        list: { prs: PRS, errors: [], connect: null },
        reading: false,
        problem: "Couldn't load pull requests.",
      }).kind,
    ).toBe("rows");
  });

  it("offers to connect GitHub where Cloud keeps no link, and lists nothing beside it", () => {
    expect(
      listView({
        list: { prs: [], errors: [], connect: "https://cloud.test/cave-agent/code" },
        ...read,
      }),
    ).toEqual({ kind: "connect", url: "https://cloud.test/cave-agent/code" });
  });

  it("draws the two groups, with the repositories it could not read said once under them", () => {
    const view = listView({
      list: {
        prs: PRS,
        errors: [{ repo: "acme/mobile", message: "Connect GitHub to see its pull requests." }],
        connect: null,
      },
      ...read,
    });
    expect(view.kind).toBe("rows");
    if (view.kind !== "rows") return;
    expect(view.groups.map((g) => [g.id, numbers(g.prs)])).toEqual([
      ["needs_you", [7, 12]],
      ["yours", [8]],
    ]);
    expect(view.note).toBe("Could not read acme/mobile: Connect GitHub to see its pull requests.");
  });

  it("draws nothing when nothing waits and everything could be read: the page's own empty state stays", () => {
    expect(listView({ list: { prs: [], errors: [], connect: null }, ...read })).toBe(NO_PULLS);
    expect(
      listView({
        list: { prs: PRS.filter((pr) => pr.number === 40), errors: [], connect: null },
        ...read,
      }),
    ).toBe(NO_PULLS);
  });

  it("still says what it could not read when nothing else is listed", () => {
    expect(
      listView({
        list: {
          prs: [],
          errors: [{ repo: "acme/mobile", message: "Connect GitHub to see its pull requests." }],
          connect: null,
        },
        ...read,
      }),
    ).toEqual({
      kind: "rows",
      groups: [],
      note: "Could not read acme/mobile: Connect GitHub to see its pull requests.",
    });
  });
});

describe("a pull request's foot", () => {
  it("offers only what Cloud says the person may do", () => {
    expect(footOf(detail(), true)).toEqual({
      approve: true,
      changes: true,
      comment: true,
      merge: "squash",
      ask: true,
    });
    expect(
      footOf(
        detail({
          can: { merge: false, review: false, comment: true, merge_methods: [], ready: false },
        }),
        true,
      ),
    ).toEqual({ approve: false, changes: false, comment: true, merge: null, ask: true });
    expect(
      footOf(
        detail({
          can: { merge: false, review: false, comment: false, merge_methods: [], ready: false },
        }),
        false,
      ),
    ).toEqual({ approve: false, changes: false, comment: false, merge: null, ask: false });
  });

  it("offers Merge only where it can work: the person may, it is open, and GitHub names nothing in its way", () => {
    expect(canMerge(detail())).toBe(true);
    expect(canMerge(detail({ mergeable: "unknown" }))).toBe(true);
    expect(canMerge(detail({ mergeable: "conflicting" }))).toBe(false);
    expect(canMerge(detail({ mergeable: "blocked" }))).toBe(false);
    expect(canMerge(detail({ state: "draft" }))).toBe(false);
    expect(canMerge(detail({ state: "merged" }))).toBe(false);
    expect(canMerge(detail({ can: { ...detail().can, merge: false } }))).toBe(false);
  });

  it("merges by the first method the repository allows, squash where it names none", () => {
    expect(mergeMethod(detail())).toBe("squash");
    expect(
      mergeMethod(detail({ can: { ...detail().can, merge_methods: ["rebase", "merge"] } })),
    ).toBe("rebase");
    expect(mergeMethod(detail({ can: { ...detail().can, merge_methods: [] } }))).toBe("squash");
  });

  it("offers a chat about it only while it is open or a draft, and only where a chat can start in Cloud", () => {
    expect(footOf(detail({ state: "draft" }), true).ask).toBe(true);
    expect(footOf(detail({ state: "merged" }), true).ask).toBe(false);
    expect(footOf(detail({ state: "closed" }), true).ask).toBe(false);
    expect(footOf(detail(), false).ask).toBe(false);
  });
});

describe("where Connect GitHub opens", () => {
  const cloud = "https://cloud.test";

  it("opens the address Cloud sent: relative to Cloud itself, or absolute", () => {
    expect(connectUrl("/cave-agent/code", cloud)).toBe("https://cloud.test/cave-agent/code");
    expect(connectUrl("/cave-agent/code?install=7", cloud)).toBe(
      "https://cloud.test/cave-agent/code?install=7",
    );
    expect(connectUrl("https://github.com/apps/caveman/installations/new", cloud)).toBe(
      "https://github.com/apps/caveman/installations/new",
    );
  });

  it("opens Cloud's own page where it sent none", () => {
    expect(connectUrl(undefined, cloud)).toBe("https://cloud.test/cave-agent/code");
    expect(connectUrl("  ", cloud)).toBe("https://cloud.test/cave-agent/code");
    expect(connectUrl(7, cloud)).toBe("https://cloud.test/cave-agent/code");
  });

  it("never hands a browser anything but https, or Cloud's own origin (a test Cloud on http)", () => {
    expect(connectUrl("javascript:alert(1)", cloud)).toBe("https://cloud.test/cave-agent/code");
    expect(connectUrl("http://elsewhere.test/x", cloud)).toBe("https://cloud.test/cave-agent/code");
    expect(connectUrl("/cave-agent/code", "http://127.0.0.1:8641")).toBe(
      "http://127.0.0.1:8641/cave-agent/code",
    );
  });
});

describe("a pull request's key", () => {
  it("is its repository, whatever its case, and its number", () => {
    expect(pullKey("Acme/API", 7)).toBe("acme/api#7");
    expect(pullKey("acme/api", 7)).toBe(pullKey("ACME/api", 7));
  });
});
