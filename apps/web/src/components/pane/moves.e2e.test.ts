// The hosted web's Move to and Back to <Mac> (audit C2) on what a REAL local Caveman Cloud and a real Cloud-computer
// runtime said: packages/runtime devicesAcrossMacs.e2e.test.ts ("This Mac is the window's own Mac") writes, to
// CAVEMAN_E2E_WEB_FIXTURE, Cloud's runtimes and computers lists for the person, as Cloud answered them, and for two chats on Cloud
// computers each one's workspace as its runtime has it and its session's moved_from: one Mac A moved there, and one
// born there. The web's own functions read them here as a browser tab does. Skipped without the file.
import * as fs from "node:fs";

import type { CloudComputerRow, Workspace } from "@caveman-app/session-protocol";
import { expect, test, vi } from "vitest";

// The drag engine's store reads `window` on load; nothing here drags.
vi.mock("../../panes/drag.ts", () => ({}));
import { THIS_COMPUTER } from "../../lib/platform.ts";
import { listComputers } from "../../state/cloud.ts";
import { cloudComputersView } from "../../state/useCloudComputers.ts";
import { backTo, moveOptions } from "./Moves.tsx";

const file = process.env.CAVEMAN_E2E_WEB_FIXTURE;
type Listed = { readonly runtime_id: string; readonly computer_id: string; readonly name: string; readonly kind: "laptop" | "cloud"; readonly online: boolean };
type Chat = { readonly workspace: Workspace; readonly moved_from: string | null };
type Fixture = {
  readonly macA: { readonly runtime_id: string; readonly computer_id: string; readonly name: string };
  readonly macB: { readonly runtime_id: string; readonly computer_id: string; readonly name: string };
  readonly fromMacA: Chat;
  readonly bornOnBox: Chat;
  readonly runtimes: ReadonlyArray<Listed>;
  /** GET /api/v1/code/computers?mine=true, as Cloud answered it. */
  readonly computers: unknown;
};

test.skipIf(!file || !fs.existsSync(file))("on the real Cloud's word, the hosted web offers no This Mac for a Cloud chat, and Back to the Mac it came from only for one that came from a Mac (C2)", async () => {
  const fixture = JSON.parse(fs.readFileSync(file!, "utf8")) as Fixture;
  // Cloud's computers as a tab reads them (cloud.ts listComputers, then useCloudComputers' view): Cloud computers only.
  const view = cloudComputersView(await listComputers(async () => new Response(JSON.stringify(fixture.computers), { status: 200 })));
  const computers: ReadonlyArray<CloudComputerRow> | null = view.state === "ready" ? view.computers : null;
  expect(computers?.length).toBeGreaterThanOrEqual(2);
  // A browser tab: no runtime of its own (hosted), so This Mac is never a place.
  const hosted = (chat: Chat) => moveOptions(chat.workspace, computers, fixture.runtimes, [null], true, chat.moved_from);
  for (const chat of [fixture.fromMacA, fixture.bornOnBox]) {
    expect(chat.workspace.computer.kind).toBe("caveman_cloud");
    const options = hosted(chat);
    expect(options.some((o) => o.to === "this_mac" || o.label === THIS_COMPUTER)).toBe(false);
  }
  // Born on a Cloud computer: it came from no Mac, so no Mac is offered as the way back, and Back to <Mac> shows nothing.
  expect(fixture.bornOnBox.moved_from).toBeNull();
  expect(backTo(fixture.bornOnBox.moved_from, fixture.runtimes)).toBeNull();
  expect(hosted(fixture.bornOnBox).filter((o) => o.mac)).toEqual([]);
  // Moved there from Mac A: Back to Mac A, by the computer Cloud lists for that runtime, and never Mac B.
  expect(fixture.fromMacA.moved_from).toBe(fixture.macA.runtime_id);
  const back = { to: { computer_id: fixture.macA.computer_id }, label: fixture.macA.name, mac: true };
  expect(backTo(fixture.fromMacA.moved_from, fixture.runtimes)).toEqual(back);
  expect(hosted(fixture.fromMacA)[0]).toEqual(back);
  expect(hosted(fixture.fromMacA).some((o) => typeof o.to === "object" && "computer_id" in o.to && o.to.computer_id === fixture.macB.computer_id)).toBe(false);
  // The desktop app's window, on either chat: This Mac is its own Mac (pullToThisMac), first.
  expect(moveOptions(fixture.bornOnBox.workspace, computers, fixture.runtimes, [fixture.macB.runtime_id], false, null)[0]).toEqual({ to: "this_mac", label: THIS_COMPUTER });
});
