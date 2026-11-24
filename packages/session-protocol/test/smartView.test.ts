import { describe, expect, test } from "vitest";
import type { SmartViewEntry, SmartViewItem } from "../src/protocol.ts";
import { admit, applyAdmission, autoLoads, closeEntry, placement, safeUrl, SMART_VIEW_RULES, smartViewKey, type SidebarNow } from "../src/smartView.ts";

const T0 = Date.parse("2026-11-11T10:00:00.000Z");
const pr: SmartViewItem = { kind: "pr", project_id: "caveman-repo:abc", number: 12 };
const page: SmartViewItem = { kind: "web", url: "http://localhost:5173/" };
const on = (entries: ReadonlyArray<SmartViewEntry> = []) => ({ on: true, entries });
const open = (item: SmartViewItem, at = T0, asked = false) => {
  const a = admit(on(), [], { item, title: "t", asked }, at);
  if (a.kind !== "opened") throw new Error(a.kind);
  return a.entry;
};

describe("smartViewKey", () => {
  test("one key per thing, whatever the view", () => {
    expect(smartViewKey(pr)).toBe("pr:caveman-repo:abc#12");
    expect(smartViewKey({ ...pr, view: "files" })).toBe(smartViewKey(pr));
    expect(smartViewKey({ kind: "chat", workspace_id: "ws-1" })).toBe("chat:ws-1");
    expect(smartViewKey({ kind: "image", workspace_id: "ws-1", path: "shot.png" })).toBe("image:ws-1:shot.png");
    expect(smartViewKey({ kind: "video", url: "https://x.dev/a.mp4" })).toBe("video:https://x.dev/a.mp4");
  });
});

describe("safeUrl", () => {
  test("http and https only", () => {
    expect(safeUrl(" https://example.com ")).toBe("https://example.com/");
    expect(safeUrl("http://localhost:3000/a")).toBe("http://localhost:3000/a");
    expect(safeUrl("javascript:alert(1)")).toBeUndefined();
    expect(safeUrl("file:///etc/passwd")).toBeUndefined();
    expect(safeUrl("data:text/html,hi")).toBeUndefined();
    expect(safeUrl("not a url")).toBeUndefined();
  });
});

describe("admit", () => {
  test("off: nothing opens", () => {
    expect(admit({ on: false, entries: [] }, [], { item: pr, title: "#12", asked: true }, T0)).toEqual({ kind: "off" });
  });

  test("a new item opens, with the note trimmed", () => {
    const a = admit(on(), [], { item: pr, title: "#12 Dark mode", note: "  Ready for review ", asked: false }, T0);
    expect(a).toMatchObject({ kind: "opened", entry: { id: "pr:caveman-repo:abc#12", title: "#12 Dark mode", note: "Ready for review", seq: 1, state: "open", asked: false } });
  });

  test("dedupe: an open item is not opened or pulsed again unless the person asks", () => {
    const e = open(pr);
    expect(admit(on([e]), [T0], { item: { ...pr, view: "files" }, title: "t", asked: false }, T0 + 60_000)).toMatchObject({ kind: "already_open" });
    expect(admit(on([e]), [T0], { item: pr, title: "t", asked: true }, T0 + 1)).toMatchObject({ kind: "surfaced", entry: { seq: 2, asked: true } });
  });

  test("what the person closed stays closed for the cooldown, unless they ask", () => {
    const closed = closeEntry([open(pr)], "pr:caveman-repo:abc#12", "person", T0 + 1000);
    const later = T0 + 1000 + SMART_VIEW_RULES.closedCooldownMs - 1;
    expect(admit(on(closed), [], { item: pr, title: "t", asked: false }, later)).toMatchObject({ kind: "closed_recently" });
    expect(admit(on(closed), [], { item: pr, title: "t", asked: true }, later)).toMatchObject({ kind: "opened", entry: { seq: 2 } });
    expect(admit(on(closed), [], { item: pr, title: "t", asked: false }, later + 1)).toMatchObject({ kind: "opened" });
  });

  test("what the Chief closed itself may open again", () => {
    const closed = closeEntry([open(pr)], "pr:caveman-repo:abc#12", "chief", T0);
    expect(admit(on(closed), [], { item: pr, title: "t", asked: false }, T0 + 1)).toMatchObject({ kind: "opened" });
  });

  test("rate: a minimum gap, then a burst cap per window", () => {
    expect(admit(on(), [T0], { item: page, title: "t", asked: false }, T0 + 5_000)).toEqual({ kind: "too_soon", retryAfterMs: SMART_VIEW_RULES.minGapMs - 5_000 });
    const burst = Array.from({ length: SMART_VIEW_RULES.burst }, (_, i) => T0 + i * 60_000);
    const now = burst.at(-1)! + SMART_VIEW_RULES.minGapMs;
    expect(admit(on(), burst, { item: page, title: "t", asked: false }, now)).toMatchObject({ kind: "too_soon" });
    expect(admit(on(), burst, { item: page, title: "t", asked: true }, now)).toMatchObject({ kind: "opened" });
    expect(admit(on(), burst, { item: page, title: "t", asked: false }, T0 + SMART_VIEW_RULES.burstWindowMs + 1)).toMatchObject({ kind: "opened" });
  });

  test("at most maxOpen at once, unless the person asks", () => {
    const many = Array.from({ length: SMART_VIEW_RULES.maxOpen }, (_, i) => open({ kind: "chat", workspace_id: `ws-${i}` }));
    expect(admit(on(many), [], { item: pr, title: "t", asked: false }, T0 + 1)).toEqual({ kind: "too_many_open", open: SMART_VIEW_RULES.maxOpen });
    expect(admit(on(many), [], { item: pr, title: "t", asked: true }, T0 + 1)).toMatchObject({ kind: "opened" });
  });
});

describe("entries", () => {
  test("an opened entry replaces its old self and goes last; closed ones are pruned past keepClosed", () => {
    let entries: ReadonlyArray<SmartViewEntry> = [];
    for (let i = 0; i < SMART_VIEW_RULES.keepClosed + 3; i++) {
      const e = open({ kind: "chat", workspace_id: `ws-${i}` });
      entries = closeEntry(applyAdmission(entries, { kind: "opened", entry: e }), e.id, "person", T0);
    }
    expect(entries).toHaveLength(SMART_VIEW_RULES.keepClosed);
    expect(entries[0]!.id).toBe("chat:ws-3");
    const again = admit(on(entries), [], { item: { kind: "chat", workspace_id: "ws-5" }, title: "t", asked: true }, T0 + 1);
    expect(applyAdmission(entries, again).at(-1)).toMatchObject({ id: "chat:ws-5", state: "open" });
  });

  test("closing twice changes nothing", () => {
    const once = closeEntry([open(pr)], "pr:caveman-repo:abc#12", "person", T0);
    expect(closeEntry(once, "pr:caveman-repo:abc#12", "chief", T0 + 5)).toBe(once);
    expect(closeEntry(once, "nope", "chief", T0)).toBe(once);
  });
});

describe("placement: never move what the person is reading", () => {
  const idle: SidebarNow = { asked: false, visible: true, open: true, narrow: false, home: true, touchedAt: null, now: T0 };
  test("an idle sidebar showing nothing of theirs takes it in front", () => {
    expect(placement(idle)).toBe("front");
    expect(placement({ ...idle, touchedAt: T0 - SMART_VIEW_RULES.idleMs })).toBe("front");
  });
  test("in use, reading their own tab, hidden, floating or off screen: behind, with the pulse", () => {
    expect(placement({ ...idle, touchedAt: T0 - 1_000 })).toBe("behind");
    expect(placement({ ...idle, home: false })).toBe("behind");
    expect(placement({ ...idle, open: false })).toBe("behind");
    expect(placement({ ...idle, narrow: true })).toBe("behind");
    expect(placement({ ...idle, visible: false })).toBe("behind");
  });
  test("what the person asked for comes to the front", () => {
    expect(placement({ ...idle, asked: true, home: false, touchedAt: T0 })).toBe("front");
  });
});

describe("autoLoads: only this computer loads with no click", () => {
  test("loopback loads; the internet, the local network and link-local wait", () => {
    expect(autoLoads("http://localhost:5173/")).toBe(true);
    expect(autoLoads("http://app.localhost:3000/")).toBe(true);
    expect(autoLoads("http://127.0.0.1:8080/x")).toBe(true);
    expect(autoLoads("http://[::1]:4000/")).toBe(true);
    expect(autoLoads("https://evil.example/x.png?d=secret")).toBe(false);
    expect(autoLoads("http://192.168.1.4/")).toBe(false);
    expect(autoLoads("http://169.254.169.254/latest/meta-data")).toBe(false);
    expect(autoLoads("http://localhost.evil.example/")).toBe(false);
    expect(autoLoads("javascript:alert(1)")).toBe(false);
  });
});
