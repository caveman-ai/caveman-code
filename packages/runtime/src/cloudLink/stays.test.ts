// Why a chat stays where it is, as a code (CONTRACT §11): the codes are pinned, each one in the form Cloud takes, and
// placeOf says "movable" exactly where the lid's own plan lets the chat run in Cloud, so what a phone draws from
// Cloud's list and what the chat's Mac would do never part.
import { expect, test } from "vitest";

import { lidPlan, type LidFacts } from "./preflight.ts";
import { CLOUD_STAYS, placeOf, STAYS, STAYS_CODE_FORM, type PlaceFacts } from "./stays.ts";

const OWN: PlaceFacts = { agentMoves: true, folder: false, several: false, topLevel: true };

test("the codes are these, each its own name, each one Cloud takes", () => {
  expect(Object.keys(STAYS).sort()).toEqual(
    [
      "agent",
      "caveman_not_on_cloud",
      "changes_not_saved",
      "cloud_off",
      "folder",
      "kind",
      "lid_off",
      "no_plan",
      "not_chosen",
      "not_on_github",
      "not_saved",
      "not_signed_in",
      "other",
      "save_failing",
      "several_repositories",
      "too_big",
      "too_many_files",
      "unpaid",
    ].sort(),
  );
  for (const [name, code] of Object.entries({ ...STAYS, ...CLOUD_STAYS })) {
    expect(code).toBe(name);
    expect(code).toMatch(STAYS_CODE_FORM);
  }
  expect(CLOUD_STAYS).toEqual({ repo_unverified: "repo_unverified", cloud_full: "cloud_full" });
  // No code is a sentence: nothing with a space, a capital or a full stop passes Cloud's form.
  for (const not of [
    "Folder chats stay on this Mac",
    "not saved",
    "Folder",
    "",
    "x".repeat(41),
    "9lives",
  ])
    expect(not).not.toMatch(STAYS_CODE_FORM);
});

test("what a chat is decides first, in the move's own order: its agent, a folder, several repositories, its kind", () => {
  expect(placeOf(OWN)).toEqual({ movable: true });
  expect(
    placeOf({ ...OWN, agentMoves: false, folder: true, several: true, topLevel: false }),
  ).toEqual({ movable: false, stays: { code: "agent" } });
  expect(placeOf({ ...OWN, folder: true, several: true, topLevel: false })).toEqual({
    movable: false,
    stays: { code: "folder" },
  });
  expect(placeOf({ ...OWN, several: true, topLevel: false })).toEqual({
    movable: false,
    stays: { code: "several_repositories" },
  });
  expect(placeOf({ ...OWN, topLevel: false })).toEqual({ movable: false, stays: { code: "kind" } });
  // What it is outranks whatever the plan says.
  expect(placeOf({ ...OWN, folder: true, plan: { outcome: "continues" } })).toEqual({
    movable: false,
    stays: { code: "folder" },
  });
});

test("on a Mac the plan decides the rest: it runs in Cloud, or stays for the plan's own code", () => {
  expect(placeOf({ ...OWN, plan: { outcome: "continues" } })).toEqual({ movable: true });
  expect(placeOf({ ...OWN, plan: { outcome: "continues_with_gaps" } })).toEqual({ movable: true });
  for (const code of Object.values(STAYS)) {
    expect(placeOf({ ...OWN, plan: { outcome: "pauses", code } })).toEqual({
      movable: false,
      stays: { code },
    });
    expect(placeOf({ ...OWN, plan: { outcome: "stays", code } })).toEqual({
      movable: false,
      stays: { code },
    });
  }
  // A plan that gives no code, or something that is no code: it still stays, as "other", never as a sentence.
  expect(placeOf({ ...OWN, plan: { outcome: "pauses" } })).toEqual({
    movable: false,
    stays: { code: "other" },
  });
  expect(
    placeOf({ ...OWN, plan: { outcome: "stays", code: "This project isn't on GitHub." } }),
  ).toEqual({ movable: false, stays: { code: "other" } });
  // A newer reason this build has no name for goes through as its plan gave it: Cloud keeps any code.
  expect(placeOf({ ...OWN, plan: { outcome: "pauses", code: "a_reason_from_later" } })).toEqual({
    movable: false,
    stays: { code: "a_reason_from_later" },
  });
});

/** Every combination of the facts the lid's plan reads that changes its answer. */
function* everyFacts(): Generator<LidFacts> {
  const bools = [true, false];
  for (const engine of ["caveman", "claude-agent", "codex", "acp:other"])
    for (const kind of ["chat", "chief", "builder"] as const)
      for (const signedIn of bools)
        for (const moves of ["on", "off", "ask"] as const)
          for (const gitHubRepo of bools)
            for (const cloudComputers of bools)
              for (const cavemanOnCloud of bools)
                for (const cavemanPaid of [true, false, undefined])
                  for (const cloudLogin of [true, false, undefined])
                    for (const copy of ["current", "behind", "failing", "none"] as const)
                      for (const wip of ["fits", "too_big", "full", "failed"] as const)
                        yield {
                          engine,
                          kind,
                          signedIn,
                          moves,
                          // The lid's own two switches, on: a summary asks whether the chat could run in Cloud at all.
                          moveToCloud: true,
                          moveOtherEngines: true,
                          gitHubRepo,
                          cloudComputers,
                          cavemanOnCloud,
                          cavemanPaid,
                          cloudLogin,
                          copy,
                          wipDropped: wip !== "fits",
                          ...(wip === "full" ? { copyFull: true } : {}),
                          ...(wip === "failed" ? { wipFailed: "git failed" } : {}),
                          nativeOff: false,
                        };
}

test("placeOf agrees with the lid's plan on every combination of its facts: movable exactly where the chat would run in Cloud, and a code of ours where the plan gives one", () => {
  let walked = 0;
  const codes = new Set<string>();
  for (const facts of everyFacts()) {
    walked++;
    const plan = lidPlan(facts);
    const code = (plan as { readonly code?: string }).code;
    const place = placeOf({
      ...OWN,
      agentMoves: ["caveman", "claude-agent", "codex"].includes(facts.engine),
      topLevel: facts.kind === "chat",
      plan: { outcome: plan.outcome, code },
    });
    const runs = plan.outcome === "continues" || plan.outcome === "continues_with_gaps";
    expect(place.movable, JSON.stringify(facts)).toBe(runs);
    if (place.movable) continue;
    codes.add(place.stays.code);
    expect(place.stays.code).toMatch(STAYS_CODE_FORM);
    // Where the plan names its reason, the summary carries that name, and it is one this module lists.
    if (
      code !== undefined &&
      ["caveman", "claude-agent", "codex"].includes(facts.engine) &&
      facts.kind === "chat"
    ) {
      expect(place.stays.code).toBe(code);
      expect(Object.values(STAYS)).toContain(code);
    }
  }
  expect(walked).toBeGreaterThan(10_000);
  // What a chat is, at least, has its own code whatever the plan carries.
  expect([...codes]).toEqual(expect.arrayContaining(["agent", "kind"]));
});
