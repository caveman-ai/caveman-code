import { createEnvelope, serializeEnvelope, type Envelope, type Transport } from "@sentry/core";
import { existsSync, mkdtempSync, readdirSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import { drainSpool, gatedTransport, MAX_HELD, readSpool } from "../src/crashReports.ts";
import type { CrashGate } from "../src/telemetry.ts";

const envelope = (id: string): Envelope =>
  createEnvelope({ event_id: id }, [
    [{ type: "event" }, { event_id: id, message: id }],
  ]) as Envelope;
const inner = () => {
  const sent: string[] = [];
  const transport: Transport = {
    send: async (e) => (sent.push(String((e[0] as { event_id: string }).event_id)), {}),
    flush: async () => true,
  };
  return { sent, transport };
};

describe("the gated transport", () => {
  it("sends, holds until released, or drops, as the gate says at each send", async () => {
    let gate: CrashGate = "hold";
    const { sent, transport } = inner();
    const t = gatedTransport(
      transport,
      async () => gate,
      () => undefined,
    );
    await t.send(envelope("a"));
    await t.send(envelope("b"));
    expect(sent).toEqual([]);
    await t.release();
    expect(sent).toEqual([]);
    gate = "send";
    await t.release();
    expect(sent).toEqual(["a", "b"]);
    await t.send(envelope("c"));
    gate = "drop";
    await t.send(envelope("d"));
    expect(sent).toEqual(["a", "b", "c"]);
  });

  it("drops what it held when the gate closes, and holds at most MAX_HELD", async () => {
    let gate: CrashGate = "hold";
    const { sent, transport } = inner();
    const t = gatedTransport(
      transport,
      async () => gate,
      () => undefined,
    );
    for (let i = 0; i < MAX_HELD + 5; i++) await t.send(envelope(String(i)));
    gate = "drop";
    await t.release();
    gate = "send";
    await t.release();
    expect(sent).toEqual([]);
    gate = "hold";
    for (let i = 0; i < MAX_HELD + 5; i++) await t.send(envelope(String(i)));
    gate = "send";
    await t.release();
    expect(sent).toHaveLength(MAX_HELD);
  });
});

describe("the runtime's spool", () => {
  const spool = (names: string[]) => {
    const dir = mkdtempSync(join(tmpdir(), "caveman-crash-spool-"));
    for (const name of names) writeFileSync(join(dir, name), serializeEnvelope(envelope(name)));
    return dir;
  };

  it("sends each report through the transport and deletes it, oldest first", async () => {
    const dir = spool(["2-b.envelope", "1-a.envelope"]);
    const send = vi.fn(async (_envelope: Envelope) => undefined);
    expect(await drainSpool(dir, async () => "send", send)).toBe(2);
    expect(send.mock.calls.map(([e]) => (e[0] as { event_id: string }).event_id)).toEqual([
      "1-a.envelope",
      "2-b.envelope",
    ]);
    expect(readdirSync(dir)).toEqual([]);
  });

  it("leaves them for after the disclosure, and deletes them unsent when they may not go", async () => {
    const dir = spool(["1-a.envelope"]);
    const send = vi.fn(async (_envelope: Envelope) => undefined);
    expect(await drainSpool(dir, async () => "hold", send)).toBe(0);
    expect(readdirSync(dir)).toEqual(["1-a.envelope"]);
    expect(await drainSpool(dir, async () => "drop", send)).toBe(0);
    expect(readdirSync(dir)).toEqual([]);
    expect(send).not.toHaveBeenCalled();
  });

  it("deletes a damaged report, an unfinished write once stale, and one too old to matter", async () => {
    const dir = spool(["3-ok.envelope"]);
    writeFileSync(join(dir, "1-bad.envelope"), "not an envelope");
    writeFileSync(join(dir, "2-new.envelope.tmp"), "half");
    writeFileSync(join(dir, "0-old.envelope.tmp"), "half");
    writeFileSync(join(dir, "0-ancient.envelope"), serializeEnvelope(envelope("ancient")));
    const longAgo = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000);
    utimesSync(join(dir, "0-ancient.envelope"), longAgo, longAgo);
    utimesSync(join(dir, "0-old.envelope.tmp"), longAgo, longAgo);
    expect(
      readSpool(dir).map(({ file, envelope }) => [
        file.slice(dir.length + 1),
        envelope !== undefined,
      ]),
    ).toEqual([
      ["1-bad.envelope", false],
      ["3-ok.envelope", true],
    ]);
    expect(existsSync(join(dir, "0-ancient.envelope"))).toBe(false);
    expect(existsSync(join(dir, "0-old.envelope.tmp"))).toBe(false);
    expect(existsSync(join(dir, "2-new.envelope.tmp"))).toBe(true);
    const send = vi.fn(async (_envelope: Envelope) => undefined);
    expect(await drainSpool(dir, async () => "send", send)).toBe(1);
    expect(readdirSync(dir)).toEqual(["2-new.envelope.tmp"]);
  });
});
