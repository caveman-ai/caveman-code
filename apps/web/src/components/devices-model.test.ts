import { newDeviceKeyPair, verifyStatement, webCryptoDeviceKey } from "@caveman-app/session-protocol/devices";
import { expect, test } from "vitest";

import { allowedCopy, allowStatement, joinTargets, notSharedCopy, ownCodeCopy, pairingAnnouncement, pairingCopy, promptPick, removeConfirmCopy, removedCopy, removeStatement, requestCopy, requestRowCopy, upgradeOf, waitingCountCopy } from "./devices-model.ts";

const family = { family: { organization_id: "org-1", user_id: "user-1" } };
const key = async (name: string, kind?: "mac") => webCryptoDeviceKey({ ...(await newDeviceKeyPair()), name, ...(kind ? { kind } : {}) });

test("each row says how the device was allowed or removed", () => {
  expect(allowedCopy({ allowed_by: { device_id: "a", name: "Mac A" } })).toBe("Allowed through Mac A");
  expect(allowedCopy({ shared: true })).toBe("Allowed here");
  expect(allowedCopy({})).toBe("This Mac only");
  expect(removedCopy({ removed_by: { device_id: "c", name: "Mac C" } })).toBe("Removed on Mac C");
  expect(removedCopy({})).toBe("Removed here");
  // Signed here, but Cloud would not carry it: this Mac only, and why.
  expect(allowedCopy({})).toBe("This Mac only");
  expect(notSharedCopy({ not_shared: "The person's device log is full." })).toBe(" Your other Macs did not get it: The person's device log is full.");
  expect(notSharedCopy({})).toBe("");
  // Still in this Mac's outbox (it has not reached Caveman since): the other Macs do not have it yet (m-j).
  expect(notSharedCopy({ waiting: true })).toBe(" Not yet sent to your other Macs: it goes once this Mac reaches Caveman.");
  expect(notSharedCopy({ waiting: true, not_shared: "Refused." })).toBe(" Your other Macs did not get it: Refused.");
});

test("a Mac that joined with this Mac's code is named a Mac in the question, with what allowing it also allows (decision 31)", () => {
  expect(requestCopy({ name: "iPhone, Safari", code: "4F2-9KM" }).title).toBe("iPhone, Safari wants to control this Mac. Allow?");
  expect(requestCopy({ name: "iPhone, Safari", code: "4F2-9KM" }).detail).not.toMatch(/other Macs/);
  // A Mac's app that did not join with the code asks as a device, in a device's words.
  expect(requestCopy({ name: "Studio", code: "4F2-9KM", role: "device" }).title).toBe("Studio wants to control this Mac. Allow?");
  const mac = requestCopy({ name: "Studio", code: "4F2-9KM", role: "mac" });
  expect(mac.title).toBe("Studio joined with this Mac's code. Allow it as one of your Macs?");
  // What it grants on this very Mac first: devices it allows control this Mac, and removing it removes them.
  expect(mac.detail).toContain("As a Mac it could also allow other devices to control this Mac and your Macs that take this Mac's approvals. Removing it later removes those devices too.");
  expect(mac.detail).toContain("Allow it only if you typed this Mac's code into it and it shows 4F2-9KM.");
  // A device allowed here before, joining now to count as a Mac: the same grant, and where its code is checked (it
  // drives this Mac already, so no waiting screen shows it: the app's Settings, Devices there does).
  const upgrade = requestCopy({ name: "Studio", code: "4F2-9KM", role: "mac" }, true);
  expect(upgrade.title).toBe("Let Studio allow devices for this Mac?");
  expect(upgrade.detail).toContain("Studio controls this Mac already, as a device, and joined with this Mac's code to count as one of your Macs.");
  expect(upgrade.detail).toContain("allow other devices to control this Mac");
  expect(upgrade.detail).toContain("the Caveman Code app there shows 4F2-9KM as This Mac's code (Settings, Devices)");
  // Settings' row names a Mac too, never as a plain waiting device.
  expect(requestRowCopy({ code: "4F2-9KM" })).toBe("Waiting for you. It shows 4F2-9KM.");
  expect(requestRowCopy({ code: "4F2-9KM", role: "mac" })).toBe("Joined with this Mac's code, as a Mac: it could also allow other devices to control this Mac. It shows 4F2-9KM.");
  expect(requestRowCopy({ code: "4F2-9KM", role: "mac" }, true)).toBe(
    "Joined with this Mac's code to count as a Mac: it could also allow other devices to control this Mac. Allow it only if the Caveman Code app there shows 4F2-9KM as This Mac's code (Settings, Devices).",
  );
  expect(ownCodeCopy("7QX-2DM")).toBe("This Mac's code is 7QX-2DM. When this Mac connects to another of your Macs, that Mac asks you to check it.");
});

test("Add a Mac shows the code with the time it has left, and Join lists the person's other Macs by name", () => {
  expect(pairingCopy(599_400)).toBe("Type it in Caveman Code on your other Mac: Settings, Devices, Join your other Mac. It works once, for 9:59 more.");
  expect(pairingCopy(61_000)).toMatch(/for 1:01 more\.$/);
  expect(pairingCopy(0)).toMatch(/for 0:00 more\.$/);
  const runtimes = [
    { runtime_id: "rt-b", computer_id: "c-b", name: "Studio", kind: "laptop" as const, online: true },
    { runtime_id: "rt-own", computer_id: "c-own", name: "This one", kind: "laptop" as const, online: true },
    { runtime_id: "rt-box", computer_id: "c-box", name: "Box", kind: "cloud" as const, online: true },
    { runtime_id: "rt-a", computer_id: "c-a", name: "MacBook Air", kind: "laptop" as const, online: false },
  ];
  // Only the person's other Macs (never this one, never a Cloud computer), by name.
  expect(joinTargets(runtimes, "rt-own")).toEqual([
    { runtime_id: "rt-a", name: "MacBook Air", online: false },
    { runtime_id: "rt-b", name: "Studio", online: true },
  ]);
});

test("an upgrade is a device this Mac lets in, joining now as a Mac: allowed here or through another Mac", () => {
  const entry = { device_id: "d1", name: "Studio", code: "4F2-9KM", user_id: "user-1", added_at: "2026-10-12T10:00:00Z", connected: false };
  const through = { ...entry, device_id: "d2", allowed_by: { device_id: "m", name: "Mac A" } };
  const list = { devices: [entry, through] };
  expect(upgradeOf(list, { device_id: "d1", role: "mac" })).toEqual(entry);
  expect(upgradeOf(list, { device_id: "d1" })).toBeUndefined();
  expect(upgradeOf(list, { device_id: "d2", role: "mac" })).toEqual(through);
  expect(upgradeOf(list, { device_id: "d3", role: "mac" })).toBeUndefined();
});

test("Allow and Remove are signed only with a Mac's desktop key, for this Mac's person, over the device as it asked", async () => {
  const [desktop, browser, phone] = [await key("Studio", "mac"), await key("Mac, Chrome"), await key("iPhone, Safari")];
  const request = { device_id: phone.device_id, name: phone.name, code: "4F2-9KM", user_id: "user-1", at: new Date().toISOString(), public_key: phone.public_key, role: "device" as const };
  const allow = await allowStatement(desktop, family, request);
  expect(await verifyStatement(allow)).toEqual(allow);
  expect(allow).toMatchObject({ kind: "allow", organization_id: "org-1", user_id: "user-1", device_id: phone.device_id, public_key: phone.public_key, name: "iPhone, Safari", role: "device", signer: { device_id: desktop.device_id } });
  const remove = await removeStatement(desktop, family, phone.device_id);
  expect(remove).toMatchObject({ kind: "remove", device_id: phone.device_id, signer: { device_id: desktop.device_id } });
  expect(remove).not.toHaveProperty("public_key");
  // A browser's key (its page served by Cloud) signs nothing: the Allow counts here only.
  expect(await allowStatement(browser, family, request)).toBeUndefined();
  expect(await removeStatement(browser, family, phone.device_id)).toBeUndefined();
  // Nor for a Mac that shares nothing, a device asking as another person, or one whose key it did not say.
  expect(await allowStatement(desktop, {}, request)).toBeUndefined();
  expect(await allowStatement(desktop, family, { ...request, user_id: "user-2" })).toBeUndefined();
  const { public_key: _key, ...keyless } = request;
  expect(await allowStatement(desktop, family, keyless)).toBeUndefined();
});

test("the Allow dialog keeps the request it shows: one that arrives meanwhile never takes the button, and the oldest goes first (A-2)", () => {
  const phone = { device_id: "phone", at: "2026-11-03T10:00:00Z", role: "device" as const };
  const other = { device_id: "other", at: "2026-11-03T10:00:05Z", role: "device" as const };
  const third = { device_id: "third", at: "2026-11-03T10:00:09Z", role: "device" as const };
  const none = new Set<string>();
  // The oldest first, whatever order the runtime listed them in.
  expect(promptPick([other, phone], none, null)).toMatchObject({ request: phone, index: 1, total: 2 });
  // The person is checking the phone's code; a second request arrives (newer, or listed first): the phone stays.
  expect(promptPick([phone], none, null)?.request).toBe(phone);
  const shown = promptPick([phone], none, null)!.request.device_id;
  for (const waiting of [[phone, other], [other, phone], [{ ...other, at: "2026-11-03T09:00:00Z" }, phone]]) expect(promptPick(waiting, none, shown)?.request).toBe(phone);
  expect(promptPick([third, phone, other], none, shown)).toMatchObject({ request: phone, index: 1, total: 3 });
  // Answered (gone from the list) or dismissed: the next oldest, never the one just answered.
  expect(promptPick([other, third], none, shown)).toMatchObject({ request: other, index: 1, total: 2 });
  expect(promptPick([phone, other, third], new Set(["phone"]), shown)).toMatchObject({ request: other, index: 1, total: 2 });
  expect(promptPick([], none, shown)).toBeNull();
  // The same device asking as another kind is another request: the dialog's key changes with it (the Allow waits again).
  expect(promptPick([{ ...phone, role: "mac" as const }], none, shown)?.key).not.toBe(promptPick([phone], none, shown)?.key);
  expect(waitingCountCopy(1, 1)).toBeNull();
  expect(waitingCountCopy(1, 2)).toBe("Another device is also waiting (1 of 2).");
  expect(waitingCountCopy(2, 3)).toBe("2 other devices are also waiting (2 of 3).");
});

test("Remove asks first, saying what it does on the person's other Macs; a Mac's removal takes what it allowed along (m-15)", () => {
  expect(removeConfirmCopy({ name: "iPhone, Safari" }, true)).toEqual({
    title: "Remove iPhone, Safari?",
    detail: "It stops controlling this Mac now, and your other Macs that take this Mac's approvals remove it too. To let it back in, unblock it on each Mac.",
  });
  expect(removeConfirmCopy({ name: "Studio", role: "mac" }, true).detail).toContain("Devices it allowed are removed with it.");
  // A browser (its key signs nothing): this Mac only.
  expect(removeConfirmCopy({ name: "iPhone, Safari" }, false).detail).toBe("It stops controlling this Mac now. To let it back in, unblock it here.");
});

test("Add a Mac announces events, never the countdown: shown, then used or out of time (m-14)", async () => {
  expect(pairingAnnouncement("live")).toBe("A code for your other Mac is shown. It works once, for 10 minutes.");
  expect(pairingAnnouncement("gone")).toBe("That code was used or ran out.");
  expect(pairingAnnouncement("none")).toBe("");
  // The code and its countdown, as the row shows them: nothing in them is a live region, so no second is read out.
  const { createElement } = await import("react");
  const { renderToStaticMarkup } = await import("react-dom/server");
  const { PairingCode } = await import("./Devices.tsx");
  const html = renderToStaticMarkup(createElement(PairingCode, { code: "ABCD-EFGH-JKMN", leftMs: 599_000 }));
  expect(html).toContain("ABCD-EFGH-JKMN");
  expect(html).toContain("for 9:59 more.");
  expect(html).not.toMatch(/aria-live|role="status"|role="alert"/);
});
