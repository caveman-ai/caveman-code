// The one quiet sync offer in the whole app, in Chromium against the scripted runtime: a returning person
// whose Caveman offers sync sees one line above the page, and turning it on writes the sync dialog's answer.
import type { CloudStatus } from "@caveman-app/session-protocol";
import { expect, test } from "vitest";
import { commands, page, userEvent } from "vitest/browser";
import { mountApp } from "../../test/app.tsx";
import { runtimeFixture, workspace } from "../../test/fixtures.ts";
import type { SessionPeer } from "../../test/session-peer.ts";
import { resetSyncOffer } from "../state/sync-offer.ts";

const TEXT = "See your chats on your phone and the web: turn on sync.";
const ASK: CloudStatus = { state: "connected", sync: { available: true, on: false, ask: true } };
// A device first seen long ago: past its first session and its first day.
const KNOWN = {
  "caveman.syncOffer": JSON.stringify({ firstDay: "2020-01-01", chats: 3, answer: null }),
};
const fixture = () =>
  runtimeFixture({ workspaces: [workspace("ws-1"), workspace("ws-2"), workspace("ws-3")] });
// The page keeps the offer's state for its life; each mount is a fresh launch of the device that storage describes.
const asking = (peer: SessionPeer) => {
  resetSyncOffer();
  peer.on("cloud.status", () => ASK);
};
const proof = (name: string) => commands.saveProof(name);

test("a settled person sees the line, at laptop and phone width, and turn on writes the sync answer", async () => {
  const { peer } = await mountApp("/new", fixture(), KNOWN, { setup: asking });
  const line = page.getByRole("group", { name: TEXT });
  await expect.element(line).toBeVisible();
  await expect.element(page.getByRole("button", { name: "Turn on sync" })).toBeVisible();
  await expect.element(page.getByRole("button", { name: "Dismiss" })).toBeVisible();
  await page.viewport(1440, 900);
  await proof("wave3-sync-banner-1440");
  await page.viewport(390, 844);
  await expect.element(line).toBeVisible();
  await proof("wave3-sync-banner-390");
  await userEvent.click(page.getByRole("button", { name: "Turn on sync" }));
  await expect
    .poll(() => peer.callsOf("settings.set").map((c) => c.params.settings))
    .toEqual([{ sync_chats: true, remote_control: true }]);
  await expect.element(line).not.toBeInTheDocument();
});

test("the first session shows nothing, and a running chat holds the line back", async () => {
  const first = await mountApp("/new", fixture(), {}, { setup: asking });
  await new Promise((resolve) => setTimeout(resolve, 500));
  expect(page.getByRole("group", { name: TEXT }).elements()).toHaveLength(0);
  await first.unmount();
  const busy = runtimeFixture({
    workspaces: [workspace("ws-1", { status: "working" }), workspace("ws-2"), workspace("ws-3")],
  });
  await mountApp("/new", busy, KNOWN, { setup: asking });
  await new Promise((resolve) => setTimeout(resolve, 500));
  expect(page.getByRole("group", { name: TEXT }).elements()).toHaveLength(0);
});
