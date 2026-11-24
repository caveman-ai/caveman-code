import type { ChiefItem, Result } from "@caveman-app/session-protocol";
import { expect, test } from "vitest";
import { commands, page, userEvent } from "vitest/browser";
import { mountApp } from "../../test/app.tsx";
import { chief, exchange, PROJECT, runtimeFixture, workspace } from "../../test/fixtures.ts";
import type { SessionPeer } from "../../test/session-peer.ts";
import offer from "./settings/code-plans-offer.fixture.json";

const profile = chief("c-app", "app", {
  project_id: PROJECT.id,
  project_ids: [PROJECT.id],
  project_default: true,
});
const ws = workspace("c-app", { kind: "chief" });
const OLD = "Earlier Chief answer";
const fixture = (empty = false) =>
  runtimeFixture({
    chiefs: [profile],
    projects: [PROJECT],
    workspaces: [ws],
    events: empty ? {} : { "c-app": exchange("old", "Earlier request", OLD) },
  });
const reply = (availability: "ready" | "no_key" = "ready"): Result<"chief.get"> => ({
  workspace: ws,
  chief: profile,
  availability,
  board: { items: [], change_sets: [] },
});
const box = () => page.getByRole("combobox", { name: "Message" });
const visible = (text: string) =>
  expect
    .element(page.getByRole("log").getByText(text, { exact: true }), { timeout: 2000 })
    .toBeVisible();
const clear = async () => {
  await userEvent.click(box());
  await userEvent.keyboard("/clear");
  await expect
    .element(page.getByRole("option").filter({ hasText: "/clear" }))
    .not.toHaveAttribute("aria-disabled", "true");
  await userEvent.keyboard("{Enter}");
};
const proof = (name: string) => commands.saveProof(`pr184-${name}`);
// Info-only rows may stay hidden in Chief. A warning stays visible and uses the same loose-notice ordering.
const notice = (peer: SessionPeer) =>
  peer.emit("c-app", {
    type: "notification",
    item_id: "marker",
    payload: { level: "warning", title: "Earlier notice" },
  });

// These probes run the real React app and transcript projection in Chromium. Only the runtime transport is scripted.

test("streaming: text appended to the same reply id stays visible across clear and completion", async () => {
  const { peer } = await mountApp("/chief/c-app", fixture());
  await visible(OLD);
  peer.emit(
    "c-app",
    { type: "turn.started", turn_id: "live", payload: { engine: "caveman" } },
    {
      type: "message.delta",
      turn_id: "live",
      item_id: "live-answer",
      payload: { text: "Reply begins" },
    },
  );
  await visible("Reply begins");
  await clear();
  peer.emit("c-app", {
    type: "message.delta",
    turn_id: "live",
    item_id: "live-answer",
    payload: { text: "; reply continues" },
  });
  try {
    await visible("Reply begins; reply continues");
    peer.emit(
      "c-app",
      {
        type: "message.done",
        turn_id: "live",
        item_id: "live-answer",
        payload: { role: "assistant", text: "Reply begins; reply continues" },
      },
      { type: "turn.done", turn_id: "live", payload: { status: "completed" } },
    );
    await visible("Reply begins; reply continues");
    await expect.element(page.getByText(OLD)).not.toBeInTheDocument();
  } finally {
    await proof("02-streaming");
  }
});

test("notice: a user message sent within five seconds stays visible even when inserted before the marker", async () => {
  const { peer } = await mountApp("/chief/c-app", fixture());
  await visible(OLD);
  notice(peer);
  await visible("Earlier notice");
  await clear();
  const capture = peer.hold("chief.capture");
  await userEvent.keyboard("Fresh request after notice{Enter}");
  await capture.call;
  peer.emit("c-app", {
    type: "message.done",
    item_id: "fresh-user",
    payload: { role: "user", text: "Fresh request after notice" },
  });
  try {
    await visible("Fresh request after notice");
  } finally {
    await proof("03-notice");
  }
});

test("clock behind: an empty cleared Chief shows replies from a runtime sixty seconds behind", async () => {
  const { peer } = await mountApp("/chief/c-app", fixture(true));
  await expect.element(page.getByRole("article", { name: "app says hello" })).toBeVisible();
  await clear();
  peer.emit(
    "c-app",
    ...exchange("behind", "New request", "Fresh reply from slower clock").map((e) => ({
      ...e,
      at: new Date(Date.now() - 60_000).toISOString(),
    })),
  );
  try {
    await visible("Fresh reply from slower clock");
  } finally {
    await proof("04-clock-behind");
  }
});

test("clock ahead: removing the marker does not reveal cleared messages from a runtime sixty seconds ahead", async () => {
  const f = fixture();
  f.events!["c-app"] = f.events!["c-app"]!.map((e) => ({
    ...e,
    at: new Date(Date.now() + 60_000).toISOString(),
  }));
  const { peer } = await mountApp("/chief/c-app", f);
  await visible(OLD);
  notice(peer);
  await visible("Earlier notice");
  await clear();
  // Restoring to the old turn removes the notice that anchored the old clear implementation.
  peer.emit("c-app", { type: "session.restored", payload: { at: 4 } });
  peer.emit("c-app", ...exchange("fresh", "New request", "Fresh reply after marker removal"));
  try {
    await visible("Fresh reply after marker removal");
    await expect.element(page.getByText(OLD), { timeout: 2000 }).not.toBeInTheDocument();
  } finally {
    await proof("04-clock-ahead");
  }
});

test("setup: empty keyless Chief keeps Add a key and Unlock after clear and reopening", async () => {
  const setup = (peer: SessionPeer) => {
    peer.on("chief.get", () => reply("no_key"));
    peer.on("account.get", () => ({ signed_in: true, role: "owner", offer }));
  };
  const app = await mountApp("/chief/c-app", fixture(true), {}, { setup });
  await expect.element(page.getByRole("button", { name: "Add a key", exact: true })).toBeVisible();
  await expect.element(page.getByRole("button", { name: "Unlock", exact: true })).toBeVisible();
  await clear();
  try {
    await expect
      .element(page.getByRole("button", { name: "Add a key", exact: true }), { timeout: 2000 })
      .toBeVisible();
    await app.unmount();
    await mountApp("/chief/c-app", fixture(true), {}, { setup, keepStorage: true });
    await expect
      .element(page.getByRole("button", { name: "Add a key", exact: true }))
      .toBeVisible();
    await expect.element(page.getByRole("button", { name: "Unlock", exact: true })).toBeVisible();
  } finally {
    await proof("05-setup");
  }
});

test.each([false, true])(
  "runtime: independent visibility with identical ids (legacy home fallback: %s)",
  async (legacy) => {
    const setup = (peer: SessionPeer) => {
      if (legacy)
        peer.on("chief.get", () => ({
          workspace: ws,
          availability: "ready",
          board: { items: [], change_sets: [] },
        }));
    };
    const app = await mountApp(
      "/chief/c-app",
      fixture(),
      {},
      {
        setup,
        runtimeUrl: "ws://runtime.test/a",
      },
    );
    await visible(OLD);
    await clear();
    await app.unmount();
    // Identical histories deliberately isolate view preferences from content and item-id differences.
    const b = await mountApp(
      "/chief/c-app",
      fixture(),
      {},
      {
        setup,
        runtimeUrl: "ws://runtime.test/b",
        keepStorage: true,
      },
    );
    await b.peer.nextCall("chief.get");
    try {
      await visible(OLD);
    } finally {
      await proof(legacy ? "06-runtime-home" : "06-runtime");
    }
  },
);

const withoutEpoch = (peer: SessionPeer) =>
  peer.on("session.attach", () => ({ session: peer.journalOf("c-app").session }));

test("result media: a hidden card does not suppress a fresh reply's screenshots or preview", async () => {
  const f = fixture();
  const at = "2026-01-01T00:00:00.000Z";
  const media =
    '<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180"><rect width="320" height="180" fill="#18202d"/><text x="24" y="52" fill="white" font-size="24">Pricing preview</text></svg>';
  const item: ChiefItem = {
    id: "pricing",
    chief_id: profile.id,
    number: 12,
    text: "Pricing page",
    title: "Pricing page",
    state: "review",
    rank: 1,
    pinned: false,
    project_ids: [PROJECT.id],
    source: "chief",
    workspace_ids: ["pricing-chat"],
    created_at: at,
    updated_at: at,
    proof: [
      {
        workspace_id: "pricing-chat",
        at,
        images: [
          {
            id: "pricing-image",
            name: "pricing.svg",
            mime_type: "image/svg+xml",
            size_bytes: media.length,
            caption: "Pricing screenshot",
            path: "/state/attachments/pricing.svg",
          },
        ],
      },
    ],
  };
  f.board = { items: [item], change_sets: [] };
  f.workspaces!.push(
    workspace("pricing-chat", {
      title: "Pricing page",
      preview: { command: "pnpm dev --port {port}", path: "/pricing", registered_at: at },
    }),
  );
  f.events!["c-app"]!.push({
    type: "notification",
    item_id: "pricing-result",
    payload: {
      level: "info",
      title: "Pricing page done",
      moment: { kind: "result", workspace_id: "pricing-chat", item_id: item.id },
    },
  });
  const { peer } = await mountApp(
    "/chief/c-app",
    f,
    {},
    {
      setup: (peer) => {
        peer.on("media.read", ({ path }) => ({
          path,
          mime_type: "image/svg+xml",
          size: media.length,
          data: btoa(media),
        }));
      },
    },
  );
  const log = page.getByRole("log");
  const preview = () => log.getByRole("button", { name: "Open preview", exact: true });
  const image = () => log.getByRole("img", { name: "Pricing screenshot", exact: true });
  await expect.element(preview(), { timeout: 2000 }).toBeVisible();
  await expect.element(image(), { timeout: 2000 }).toBeVisible();
  await proof("08-result-media-before-clear");
  await clear();
  await expect.element(preview()).not.toBeInTheDocument();
  peer.emit("c-app", ...exchange("pricing-fresh", "Show pricing again", "Review [[12]]."));
  try {
    await expect
      .element(log.getByRole("link", { name: "Pricing page", exact: true }), { timeout: 2000 })
      .toBeVisible();
    await expect.element(preview(), { timeout: 2000 }).toBeVisible();
    await expect.element(image(), { timeout: 2000 }).toBeVisible();
    await proof("08-result-media-fresh");
    await userEvent.click(page.getByRole("button", { name: "Show earlier" }));
    await expect
      .poll(() => log.element().querySelectorAll('[data-moment="result"]').length)
      .toBe(1);
    await expect.element(preview()).toHaveLength(1);
    await expect.element(image()).toHaveLength(1);
  } finally {
    await proof("08-result-media-restored");
  }
});

test("epoch optional: legacy runtime can clear and reopen without reporting an epoch", async () => {
  const app = await mountApp("/chief/c-app", fixture(), {}, { setup: withoutEpoch });
  await visible(OLD);
  try {
    await userEvent.click(box());
    await userEvent.keyboard("/clear");
    await expect
      .element(page.getByRole("option").filter({ hasText: "/clear" }), { timeout: 2000 })
      .not.toHaveAttribute("aria-disabled", "true");
    await userEvent.keyboard("{Enter}");
    await expect.element(page.getByText(OLD)).not.toBeInTheDocument();
    await app.unmount();
    await mountApp("/chief/c-app", fixture(), {}, { setup: withoutEpoch, keepStorage: true });
    await expect.element(page.getByRole("note").filter({ hasText: /^Today/ })).toBeVisible();
    await expect.element(page.getByText(OLD)).not.toBeInTheDocument();
  } finally {
    await proof("07-legacy-epoch");
  }
});

test("epoch unknown: an uncached saved clear hides history before epoch arrives", async () => {
  const uncached = { ...ws, session_id: "s-uncached-epoch" };
  const f = fixture();
  f.workspaces = [uncached];
  await mountApp(
    "/chief/c-app",
    f,
    {},
    {
      keepStorage: true,
      setup: (peer) => {
        peer.on("chief.get", () => ({ ...reply(), workspace: uncached }));
        withoutEpoch(peer);
        // A mark written by #184 before the epoch fix, with no cached transcript to supply its epoch.
        const scope = JSON.stringify([
          "ws://runtime.test",
          "/",
          profile.id,
          uncached.session_id,
          1,
        ]);
        localStorage.setItem(
          `caveman.chief.cleared.v2.${scope}`,
          JSON.stringify({ at: new Date().toISOString(), cursor: 4, live: [] }),
        );
      },
    },
  );
  try {
    await expect
      .element(page.getByRole("note").filter({ hasText: /^Today/ }), { timeout: 2000 })
      .toBeVisible();
    await expect.element(page.getByText(OLD)).not.toBeInTheDocument();
    await proof("07-unknown-epoch-cleared");
    await userEvent.click(page.getByRole("button", { name: "Show earlier" }));
    await visible(OLD);
  } finally {
    await proof("07-unknown-epoch");
  }
});

test("epoch arrival: bind a legacy clear once, then release it for a different journal", async () => {
  const legacy = await mountApp("/chief/c-app", fixture(), {}, { setup: withoutEpoch });
  await visible(OLD);
  await clear();
  await legacy.unmount();
  const atEpoch = (epoch: number) => (peer: SessionPeer) =>
    peer.on("session.attach", () => ({ session: peer.journalOf("c-app").session, epoch }));
  const known = await mountApp(
    "/chief/c-app",
    fixture(),
    {},
    { setup: atEpoch(1), keepStorage: true },
  );
  await expect.element(page.getByRole("note").filter({ hasText: /^Today/ })).toBeVisible();
  await expect.element(page.getByText(OLD)).not.toBeInTheDocument();
  await expect
    .poll(() =>
      Object.keys(localStorage)
        .filter((k) => k.startsWith("caveman.chief.cleared.v2."))
        .some((k) => JSON.parse(localStorage.getItem(k)!).epoch === 1),
    )
    .toBe(true);
  await known.unmount();
  await mountApp("/chief/c-app", fixture(), {}, { setup: atEpoch(2), keepStorage: true });
  await visible(OLD);
});
