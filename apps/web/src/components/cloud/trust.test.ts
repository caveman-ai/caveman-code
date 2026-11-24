import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { CloudAvailableSwitch, connectorCloudView, optInRepository, profileItemFor, profileItemView, serverKeysWhere, type ProfileStatus } from "./trust.tsx";
import { THIS_COMPUTER, thisComputer } from "../../lib/platform.ts";

describe("a connector's Cloud badge", () => {
  it("offers Move to Cloud for a sign-in this Mac made before linking, and only for that", () => {
    expect(connectorCloudView({ status: "connected", held_by: "this_computer", auth: "oauth" })).toMatchObject({ label: `${THIS_COMPUTER} only — signed in before Cloud`, move: true });
    expect(connectorCloudView({ status: "connected", held_by: "cloud", auth: "oauth" })).toMatchObject({ label: "Sign-in on Cloud", move: false });
    // This Mac's gh login is not moved: Cloud's GitHub login is connected in the console.
    expect(connectorCloudView({ status: "connected", held_by: "this_computer", auth: "github" })).toMatchObject({ move: false });
    expect(connectorCloudView({ status: "needs_sign_in", problem: "Linear refused the refresh token." })).toMatchObject({ label: "Reconnect", move: false });
    expect(connectorCloudView({ status: "needs_sign_in" })).toBeNull();
  });

  it("shows the Mac-only endpoint even while its OAuth connection still needs sign-in", () => {
    const reason = "it reaches 127.0.0.1, a service on This Mac";
    const item = { kind: "server" as const, id: "loopback", cloud: "mac_only" as const, reason };
    expect(connectorCloudView({ status: "needs_sign_in", problem: "Sign in to the server", auth: "oauth" }, item)).toEqual({ tone: "neutral", label: `${THIS_COMPUTER} only — ${reason}`, title: `${THIS_COMPUTER} only: ${reason}`, move: false });
  });

  it("does not mistake a Cloud-held sign-in for a reachable MCP endpoint", () => {
    const item = { kind: "server" as const, id: "private", cloud: "needs_runtime" as const, reason: "the private network must be available on the computer" };
    expect(connectorCloudView({ status: "connected", held_by: "cloud", auth: "oauth" }, item)).toEqual({ tone: "yellow", label: `Needs setup in Cloud — ${item.reason}`, title: `Your Cloud computers get it, but ${item.reason}.`, move: false });
  });

  it("says why only this Mac holds a sign-in Cloud cannot make, and offers no move", () => {
    const reason = "Signed in on this Mac only, because Caveman Cloud refused it: The server did not answer, so Caveman cannot find how to sign in to it.";
    for (const status of ["connected", "signing_in"]) {
      expect(connectorCloudView({ status, held_by: "this_computer", held_reason: reason, auth: "oauth" })).toEqual({
        tone: "neutral",
        label: `${THIS_COMPUTER} only — Cloud can't sign in to it`,
        title: reason,
        move: false,
      });
    }
  });
});

describe("a plugin, server or skill's Cloud badge", () => {
  it("claims only what This Mac checked: a server is synced, never shown working, until it lists its tools on a computer", () => {
    expect(profileItemView({ kind: "server", id: "files", cloud: "runs" })).toMatchObject({ tone: "green", label: "Synced to Cloud" });
    expect(profileItemView({ kind: "plugin", id: "kit@kit", cloud: "runs" })).toMatchObject({ tone: "green", label: "Works in Cloud" });
    // Kept on there, but missing something: not "This Mac only".
    expect(profileItemView({ kind: "server", id: "local", cloud: "needs_runtime", reason: "it runs ./server.js from the folder it starts in, so a Cloud computer needs that file too" })).toMatchObject({
      tone: "yellow",
      label: "Needs setup in Cloud — it runs ./server.js from the folder it starts in, so a Cloud computer needs that file too",
    });
    expect(profileItemView({ kind: "server", id: "dev", cloud: "mac_only", reason: "it reaches 127.0.0.1, a service on This Mac" })).toMatchObject({ tone: "neutral", label: `${THIS_COMPUTER} only — it reaches 127.0.0.1, a service on This Mac` });
    // A skill without some of its files, or one of several folders of its name, is not shown as working.
    expect(profileItemView({ kind: "skill", id: "deploy", cloud: "runs", reason: "left out: bin/tool (a binary file: only text syncs)" })).toMatchObject({ tone: "yellow", label: "Partly in Cloud — left out: bin/tool (a binary file: only text syncs)" });
  });

  it("finds a home skill's line by its path, so same-named folders each show their own outcome", () => {
    const status: ProfileStatus = {
      state: "ok",
      items: [
        { kind: "skill", id: "deploy", cloud: "runs", reason: "~/.codex/skills/deploy, named the same with other files, stays on This Mac", path: "/h/.claude/skills/deploy/SKILL.md" },
        { kind: "skill", id: "deploy", cloud: "skipped", reason: "~/.claude/skills/deploy has a skill of the same name with other files", path: "/h/.codex/skills/deploy/SKILL.md" },
      ],
    };
    expect(profileItemFor(status, "skill", ["deploy"], "/h/.codex/skills/deploy/SKILL.md")?.cloud).toBe("skipped");
    expect(profileItemFor(status, "skill", ["deploy"], "/h/.claude/skills/deploy/SKILL.md")?.cloud).toBe("runs");
    expect(profileItemFor(status, "skill", ["deploy"], "/h/.agents/skills/other/SKILL.md")).toBeUndefined();
    // A runtime that names no paths (a Cloud computer's own lines) cannot say anything about a home folder.
    expect(profileItemFor({ state: "ok", items: [{ kind: "skill", id: "deploy", cloud: "runs" }] }, "skill", ["deploy"], "/h/.claude/skills/deploy/SKILL.md")).toBeNull();
  });
});

describe("server keys on Cloud computers", () => {
  it("says who else can read them where servers share the agents' user", () => {
    expect(serverKeysWhere("linear", true)).toBe("the linear server's process; commands your agents run on that computer can read them too");
    expect(serverKeysWhere("linear", false)).toBe("the linear server's process, which runs as its own user there, apart from the commands your agents run");
  });
});

describe("Use on Cloud when starting a Cloud workspace", () => {
  it("answers Cloud's refusal instead of failing the start", async () => {
    const refused = { call: () => Promise.reject({ error: { code: -32000, message: "Caveman Cloud did not answer." } }) };
    await expect(optInRepository(refused as never, { url: "https://github.com/acme/widgets" })).resolves.toBe("Caveman Cloud did not answer.");
    const sent: Array<[string, unknown]> = [];
    const ok = { call: (m: string, p: unknown) => (sent.push([m, p]), Promise.resolve({ repository: "github.com/acme/widgets", available: true, names: ["API_TOKEN"] })) };
    await expect(optInRepository(ok as never, { url: "https://github.com/acme/widgets" })).resolves.toBeUndefined();
    expect(sent).toEqual([["cloud.secrets.set_available", { request_id: expect.any(String), repo: { url: "https://github.com/acme/widgets" }, available: true }]]);
  });
});

describe("Settings > Secrets: a repository's Cloud switch", () => {
  const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");

  it("names the values Cloud holds while the switch is off, instead of saying they stay on this computer", () => {
    // Add from this Mac sent STRIPE_KEY (cloud.secrets.set_available with names); the repository's switch stayed off.
    const html = renderToStaticMarkup(
      createElement(CloudAvailableSwitch, { target: "repository", owner: "github.com/acme/gadgets", names: ["AWS_SECRET", "STRIPE_KEY"], held: ["STRIPE_KEY"], available: false, onSet: async () => {} }),
    );
    expect(html).toContain('aria-checked="false"');
    expect(text(html)).not.toContain("the values stay on");
    expect(text(html)).toContain("Caveman keeps an encrypted copy of STRIPE_KEY");
    expect(text(html)).toContain(`The other values stay on ${thisComputer}.`);
  });

  it("says the values stay on this computer when Cloud holds none of them", () => {
    const html = renderToStaticMarkup(
      createElement(CloudAvailableSwitch, { target: "repository", owner: "github.com/acme/gadgets", names: ["AWS_SECRET", "STRIPE_KEY"], held: [], available: false, onSet: async () => {} }),
    );
    expect(text(html)).toContain(`Off: the values stay on ${thisComputer}. Cloud computers start without them.`);
  });
});
