// The lid's preflight over every engine, repository, chat kind, setting and copy state (AC-12, WORKLIST S06): each
// cell has an outcome and a reason, each that does not continue has a fix, and an unsupported chat never reads
// "continues". What reaches a person names the account Caveman (a self-hosted install a Caveman server), as the
// runtime's own errors do; Cloud computers keep their name.
import { describe, expect, test } from "vitest";

import { CAVEMAN_NOT_ON_CLOUD, CAVEMAN_UNPAID, COPY_FULL, COPY_FULL_REASON, GAP_TRANSCRIPT, lidPlan, moveContext, noCloudLogin, NOT_COPIED, wipTooBig, type ChatKind, type LidFacts } from "./preflight.ts";

const ready: LidFacts = {
  engine: "caveman",
  kind: "chat",
  signedIn: true,
  moves: "on",
  moveToCloud: true,
  moveOtherEngines: true,
  gitHubRepo: true,
  cloudComputers: true,
  cavemanOnCloud: true,
  cloudLogin: true,
  copy: "current",
  wipDropped: false,
  nativeOff: false,
};

const ENGINES = ["caveman", "claude-agent", "codex", "cursor", "opencode", "pi", "grok", "muse", "acp:gemini"] as const;
const REPOS = { github: true, other: false, none: false } as const;
const KINDS: ReadonlyArray<ChatKind> = ["chat", "chief", "setup", "builder", "delegated"];
const SETTINGS: ReadonlyArray<Partial<LidFacts>> = [{}, { signedIn: false }, { moves: "ask" }, { moves: "off" }, { moveToCloud: false }, { moveOtherEngines: false }, { cloudComputers: false }, { cavemanOnCloud: false }, { cavemanPaid: false }];
const COPIES: ReadonlyArray<Partial<LidFacts>> = [{}, { copy: "behind" }, { copy: "none" }, { copy: "failing", copyError: "Could not reach Caveman: fetch failed" }, { wipDropped: true, wipBytes: 12 * 1024 * 1024 }, { wipDropped: true, wipBytes: 12 * 1024 * 1024, copyFull: true }, { nativeOff: true }];
const LOGINS: ReadonlyArray<boolean | undefined> = [true, false, undefined];

describe("the lid's preflight", () => {
  test("every cell has an outcome and a reason; every one that does not continue has a fix; an unsupported chat never continues; none says Caveman Cloud", () => {
    let cells = 0;
    for (const engine of ENGINES)
      for (const [repo, gitHubRepo] of Object.entries(REPOS))
        for (const kind of KINDS)
          for (const settings of SETTINGS)
            for (const copy of COPIES)
              for (const cloudLogin of LOGINS) {
                const facts: LidFacts = { ...ready, engine, kind, gitHubRepo, cloudLogin, ...settings, ...copy };
                const plan = lidPlan(facts);
                const where = JSON.stringify({ engine, repo, kind, settings, copy, cloudLogin });
                cells++;
                expect(plan.reason, where).toMatch(/\S/);
                if (plan.outcome === "pauses" || plan.outcome === "stays") expect(plan.fix, where).toMatch(/\S/);
                expect(`${plan.reason} ${plan.fix ?? ""}`, where).not.toMatch(/Caveman Cloud/);
                const supported = ["caveman", "claude-agent", "codex"].includes(engine) && kind === "chat" && gitHubRepo;
                if (!supported) expect(plan.outcome, where).toBe("stays");
                if (plan.outcome.startsWith("continues")) {
                  expect(facts.moves === "on" && facts.moveToCloud && !facts.wipDropped && facts.copy !== "failing" && facts.copy !== "none", where).toBe(true);
                  if (engine !== "caveman") expect(facts.moveOtherEngines && facts.cloudLogin !== false, where).toBe(true);
                  else expect(facts.cavemanOnCloud && facts.cavemanPaid !== false, where).toBe(true);
                  expect(plan.outcome === "continues_with_gaps", where).toBe(plan.gaps.length > 0);
                }
              }
    expect(cells).toBe(ENGINES.length * 3 * KINDS.length * SETTINGS.length * COPIES.length * LOGINS.length);
  });

  test("a Caveman chat stays on this Mac where Cloud computers cannot run it (no Caveman credits reach them)", () => {
    expect(lidPlan({ ...ready, cavemanOnCloud: false })).toMatchObject({ outcome: "pauses", reason: CAVEMAN_NOT_ON_CLOUD, fix: expect.stringMatching(/\S/) });
    expect(lidPlan({ ...ready, cavemanOnCloud: true }).outcome).toBe("continues");
    // Claude Agent and Codex chats run on their own logins there: the word is about Caveman's only.
    expect(lidPlan({ ...ready, engine: "codex", cavemanOnCloud: false }).outcome).toBe("continues");
    // A setup issue says its own fix first.
    expect(lidPlan({ ...ready, cavemanOnCloud: false, moves: "off" }).reason).toBe("Moving chats to Cloud is off on this Mac (Settings, Computers)");
  });

  test("a Caveman chat pays from its person's credits or plan on a Cloud computer: with neither it stays, saying what fixes it", () => {
    const unpaid = lidPlan({ ...ready, cavemanPaid: false });
    expect(unpaid).toMatchObject({ outcome: "pauses", reason: CAVEMAN_UNPAID, fix: expect.stringMatching(/Settings, Plan/) });
    // Only what pays, never what it costs.
    expect(`${unpaid.reason} ${unpaid.fix}`).not.toMatch(/\$|\d/);
    // A Cloud that does not say (a lab on a computer's own key, an older Cloud) is taken at its word: it runs them.
    expect(lidPlan({ ...ready, cavemanPaid: undefined }).outcome).toBe("continues");
    expect(lidPlan({ ...ready, cavemanPaid: true }).outcome).toBe("continues");
    // Claude Agent and Codex chats pay on their own logins.
    expect(lidPlan({ ...ready, engine: "claude-agent", cavemanPaid: false }).outcome).toBe("continues");
    // Where Caveman chats run on no Cloud computer, that says why first.
    expect(lidPlan({ ...ready, cavemanOnCloud: false, cavemanPaid: false }).reason).toBe(CAVEMAN_NOT_ON_CLOUD);
  });

  test("each check, in the lid's order, says why and how to fix it", () => {
    expect(lidPlan({ ...ready, signedIn: false })).toMatchObject({ outcome: "pauses", reason: "Sign in to Caveman first (Settings, Remote control)" });
    expect(lidPlan({ ...ready, engine: "cursor" })).toMatchObject({ outcome: "stays", reason: "This engine's chats stay on the computer they started on" });
    for (const kind of ["chief", "setup", "builder", "delegated"] as const)
      expect(lidPlan({ ...ready, kind })).toMatchObject({ outcome: "stays", reason: "This chat stays here: the Chief, setup chats and delegated agents don't move" });
    expect(lidPlan({ ...ready, moves: "ask" })).toMatchObject({ outcome: "pauses", reason: "Moving chats to Cloud isn't set up on this Mac yet (Settings, Computers)" });
    expect(lidPlan({ ...ready, moves: "off" })).toMatchObject({ outcome: "pauses", reason: "Moving chats to Cloud is off on this Mac (Settings, Computers)" });
    expect(lidPlan({ ...ready, moveToCloud: false })).toMatchObject({ outcome: "pauses", reason: "Moving chats to Cloud when the lid closes is off on this Mac (Settings, Computers)" });
    expect(lidPlan({ ...ready, gitHubRepo: false })).toMatchObject({ outcome: "stays", reason: "This chat's repository isn't on GitHub, so a Cloud computer can't check it out" });
    expect(lidPlan({ ...ready, cloudComputers: false })).toMatchObject({ outcome: "pauses", reason: "This Caveman server runs no Cloud computers" });
    expect(lidPlan({ ...ready, engine: "codex", moveOtherEngines: false })).toMatchObject({ outcome: "pauses", reason: "Codex chats stay on this Mac when the lid closes (Settings, Computers)" });
    expect(lidPlan({ ...ready, engine: "caveman", moveOtherEngines: false }).outcome).toBe("continues");
    expect(lidPlan({ ...ready, engine: "claude-agent", cloudLogin: false })).toMatchObject({ outcome: "pauses", reason: noCloudLogin("claude-agent") });
    expect(lidPlan({ ...ready, engine: "codex", cloudLogin: false }).fix).toBe("Connect your ChatGPT plan or an OpenAI API key in Settings > Models & keys.");
    // Cloud not asked: the lid's own check asks Cloud then, so the summary does not claim a pause.
    expect(lidPlan({ ...ready, engine: "claude-agent", cloudLogin: undefined }).outcome).toBe("continues");
    expect(lidPlan({ ...ready, copy: "failing", copyError: "Could not reach Caveman: fetch failed." })).toMatchObject({ outcome: "pauses", reason: "Its copy isn't reaching Caveman: Could not reach Caveman: fetch failed" });
    expect(lidPlan({ ...ready, copy: "behind" }).outcome).toBe("continues");
    expect(lidPlan({ ...ready, copy: "none" })).toMatchObject({ outcome: "pauses", reason: NOT_COPIED });
    // Secret-shaped files it leaves here (decision 24): it continues, saying which stay, a few by name.
    expect(lidPlan({ ...ready, left: [".env", "server.pem"] })).toMatchObject({ outcome: "continues_with_gaps", gaps: ["leaves .env, server.pem on this Mac"] });
    expect(lidPlan({ ...ready, left: [".env", ".env.local", "a.key", "b.pem", "id_rsa"] }).gaps).toEqual(["leaves .env, .env.local, a.key and 2 more on this Mac"]);
    expect(lidPlan({ ...ready, left: [] }).outcome).toBe("continues");
    // Its snapshot failed: what git said, and that it goes again by itself (no size to cut).
    expect(lidPlan({ ...ready, wipDropped: true, wipBytes: 0, wipFailed: "fatal: cannot lock ref 'refs/caveman/sessions/s1'." })).toMatchObject({
      outcome: "pauses",
      reason: "Its uncommitted changes didn't go into its copy: fatal: cannot lock ref 'refs/caveman/sessions/s1'",
      fix: "It tries again by itself, within a minute at most; until a copy carries them, it stays on this Mac.",
    });
    expect(lidPlan({ ...ready, wipDropped: true, wipBytes: 12 * 1024 * 1024 })).toEqual({
      outcome: "pauses",
      reason: "Its uncommitted changes are 12 MiB, more than a move carries",
      fix: "Commit and push the large files, or keep it on this Mac.",
      gaps: [],
    });
    expect(wipTooBig(12 * 1024 * 1024)).toBe("its uncommitted changes are 12 MiB, more than a move carries; commit and push the large files, or keep it on this Mac");
    // Cloud took no more chunks of its copy (AC-08): said as that, never as changes too big for a move.
    expect(lidPlan({ ...ready, wipDropped: true, wipBytes: 40 * 1024 * 1024, copyFull: true })).toEqual({ outcome: "pauses", reason: COPY_FULL_REASON, fix: "Commit and push the large files, or keep it on this Mac.", gaps: [] });
    expect(COPY_FULL).toBe("its copy with Caveman holds as many large files as one chat's copy may; commit and push the large files, or keep it on this Mac");
  });

  test("a chat that continues says what only it leaves behind; what every move leaves is said once, not per chat", () => {
    expect(lidPlan(ready)).toEqual({ outcome: "continues", reason: "It continues on a Cloud computer", gaps: [] });
    expect(lidPlan({ ...ready, engine: "claude-agent", nativeOff: true })).toEqual({ outcome: "continues_with_gaps", reason: "It continues on a Cloud computer", gaps: [GAP_TRANSCRIPT] });
    // The Caveman engine's conversation travels in its journal, never a session file.
    expect(lidPlan({ ...ready, nativeOff: true }).outcome).toBe("continues");
  });
});

describe("a move's context (decision 28)", () => {
  test("the Caveman engine always continues natively: its conversation travels in its journal", () => {
    for (const to of ["cloud", "computer", "mac"] as const) expect(moveContext({ engine: "caveman", to, session: false, nativeOff: true })).toEqual({ mode: "native" });
  });
  test("Claude Agent and Codex resume their own session on a Cloud computer, unless it is too big to copy or there is none yet", () => {
    for (const engine of ["claude-agent", "codex"] as const) {
      expect(moveContext({ engine, to: "cloud", session: true, nativeOff: false })).toEqual({ mode: "native" });
      expect(moveContext({ engine, to: "computer", session: true, nativeOff: false })).toEqual({ mode: "native" });
      expect(moveContext({ engine, to: "computer", session: true, nativeOff: true })).toEqual({ mode: "handoff", why: "over_cap" });
      expect(moveContext({ engine, to: "cloud", session: false, nativeOff: false })).toEqual({ mode: "handoff", why: "no_session" });
    }
  });
  test("a move to another Mac always hands its context over: its CLI runs on that Mac's own login (S-R2)", () => {
    expect(moveContext({ engine: "claude-agent", to: "mac", session: true, nativeOff: false })).toEqual({ mode: "handoff", why: "other_account" });
    expect(moveContext({ engine: "codex", to: "mac", session: false, nativeOff: true })).toEqual({ mode: "handoff", why: "other_account" });
  });
  test("coming home to This Mac resumes its own session there", () => {
    expect(moveContext({ engine: "claude-agent", to: "home", session: true, nativeOff: false })).toEqual({ mode: "native" });
  });
});
