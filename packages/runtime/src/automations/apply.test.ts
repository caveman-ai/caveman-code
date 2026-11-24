// What an apply's answer reads as: Cloud's states (removed, a wait for an owner who is not you), and a new webhook's
// URL, with its one-time secret only where a terminal prints it itself (CORRECTNESS L4, M5).
import { describe, expect, it } from "vitest";

import { appliedFrom, ApplyError, applyPlanFrom, renderApplied, renderHookSecrets } from "./apply.ts";

const answer = {
  automations: [
    { id: "aut_1", name: "intake", revision_id: "rev_1", state: "active", authority_diff: { widens: false, changes: [] }, hook: { id: "hk_1", path: "/api/v1/code/hooks/hk_1", secret: "whsec_once" } },
    { id: "aut_2", name: "old", revision_id: null, state: "removed", authority_diff: { widens: false, changes: [] } },
    { id: "aut_3", name: "theirs", revision_id: "rev_3", state: "pending_approval", reason: "not_owner", authority_diff: { widens: false, changes: [] } },
    { id: "aut_4", name: "wider", revision_id: "rev_4", state: "pending_approval", reason: "widens", authority_diff: { widens: true, changes: [] } },
  ],
};

describe("an apply's answer", () => {
  it("keeps Cloud's removed state and why a revision waits, and a hook only with its secret", () => {
    const applied = appliedFrom(answer);
    expect(applied.map((a) => [a.name, a.state, a.reason ?? null])).toEqual([
      ["intake", "active", null],
      ["old", "removed", null],
      ["theirs", "pending_approval", "not_owner"],
      ["wider", "pending_approval", "widens"],
    ]);
    expect(applied[0]!.hook).toEqual({ id: "hk_1", path: "/api/v1/code/hooks/hk_1", secret: "whsec_once" });
    expect(appliedFrom({ automations: [{ ...answer.automations[0], hook: { id: "hk_1", path: "/x", secret: "" } }] })[0]).not.toHaveProperty("hook");
  });

  it("reads as each state means, with the webhook's URL; the secret only in a terminal's own print", () => {
    const applied = appliedFrom(answer);
    const text = renderApplied({ repo: "acme/api", automations: applied, skipped: [], origin: "https://app.caveman.so/" });
    expect(text).toContain("intake  active: it fires from now on (revision rev_1)\n  webhook  POST https://app.caveman.so/api/v1/code/hooks/hk_1\n  secret   given once with this answer, apart from this text");
    expect(text).toContain("old  removed: this apply no longer carries its file, so Cloud stopped it");
    expect(text).toContain("theirs  waiting for its owner's approval, because you are not its owner (revision rev_3)");
    expect(text).toContain("wider  waiting for the owner's approval, because it widens what it may do (revision rev_4)");
    expect(text).not.toContain("whsec_once");
    const printed = renderApplied({ repo: "acme/api", automations: applied, skipped: [], origin: "https://app.caveman.so", secrets: true });
    expect(printed).toContain("  secret   whsec_once\n  Sign each body with it: X-Caveman-Signature: sha256=<hex HMAC-SHA256 of the body>.");
    expect(renderHookSecrets(applied)).toBe(
      "Webhook secrets:\n  intake  whsec_once\n  Sign each body with it: X-Caveman-Signature: sha256=<hex HMAC-SHA256 of the body>. Caveman shows it this once; keep it where the sender reads it.",
    );
    expect(renderHookSecrets(applied.slice(1))).toBeUndefined();
  });
});

describe("what an apply would send", () => {
  it("refuses a Cloud file with more problems than a function call takes arguments, and lists them all", () => {
    const lines = 200_000;
    const text = `host: cloud\nsteps:\n  a: { prompt: hi }\n${"#\u200b\n".repeat(lines)}`;
    let refused: unknown;
    try {
      applyPlanFrom({ sources: { files: [{ path: ".caveman/automations/a.yaml", text }], claude: [], problems: [] }, registry: [], repo: "acme/api", commitSha: "abc" });
    } catch (error) {
      refused = error;
    }
    expect(refused).toBeInstanceOf(ApplyError);
    expect((refused as ApplyError).reason).toBe("invalid");
    expect((refused as ApplyError).message.endsWith(`\n\n${lines} errors`)).toBe(true);
  }, 600_000);
});
