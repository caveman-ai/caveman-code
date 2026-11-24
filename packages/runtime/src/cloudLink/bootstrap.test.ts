// A warm Cloud computer takes its own identity: it opens what the computers service sealed to its pod, long-polls
// Cloud's bootstrap route, and takes kubelet's copy instead when that comes first.
import { getEventListeners } from "node:events";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, expect, test, vi } from "vitest";

import { openSealed, takeIdentity } from "./bootstrap.ts";

// Caveman Cloud's Caveman Cloud Sandboxes sealed by the Go side (its TestVector opens the same).
const vector = JSON.parse(fs.readFileSync(new URL("./testdata/bootstrap-v1.json", import.meta.url), "utf8")) as {
  key: string;
  sealed: string;
  files: Record<"runtime.json" | "runtime.key", string>;
};
const b64 = (s: string) => Buffer.from(s, "base64");

const dirs: Array<string> = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});
/** A pod's link mount holding its bootstrap file, and the runtime's own empty link dir. */
const pod = (cloudUrl = "https://cloud.example") => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bootstrap-"));
  dirs.push(root);
  const mount = path.join(root, "link"), linkDir = path.join(root, "link-run");
  fs.mkdirSync(mount);
  fs.mkdirSync(linkDir);
  const bootFile = path.join(mount, "bootstrap.json");
  fs.writeFileSync(bootFile, JSON.stringify({ cloud_url: cloudUrl, token: "pod-token", key: vector.key }));
  return { mount, linkDir, bootFile };
};

test("opens what the computers service sealed to the pod, and nothing else", () => {
  const files = openSealed(b64(vector.key), b64(vector.sealed));
  expect(files["runtime.json"]).toEqual(b64(vector.files["runtime.json"]));
  expect(files["runtime.key"]).toEqual(b64(vector.files["runtime.key"]));
  const tampered = b64(vector.sealed);
  tampered[tampered.length - 1]! ^= 1;
  expect(() => openSealed(b64(vector.key), tampered)).toThrow();
  expect(() => openSealed(b64(vector.key), Buffer.from([2, ...b64(vector.sealed).subarray(1)]))).toThrow(/not a sealed identity/);
});

test("asks again on 'not claimed yet' and on failures, then places the identity, the key first and readable by the runtime alone", async () => {
  const { linkDir, bootFile } = pod("https://cloud.example/");
  const asked: Array<{ url: string; body: unknown }> = [];
  const answers = [() => new Response(null, { status: 204 }), () => new Response("down", { status: 503 }), () => Response.json({ sealed: vector.sealed })];
  const from = await takeIdentity({
    bootFile,
    linkDir,
    signal: new AbortController().signal,
    fetch: (async (url: string, init: RequestInit) => {
      asked.push({ url, body: JSON.parse(String(init.body)) });
      return answers[asked.length - 1]!();
    }) as typeof fetch,
  });
  expect(from).toBe("the bootstrap route");
  expect(asked).toEqual(Array.from({ length: 3 }, () => ({ url: "https://cloud.example/api/v1/code/runtime/bootstrap", body: { token: "pod-token" } })));
  expect(fs.readFileSync(path.join(linkDir, "runtime.json"))).toEqual(b64(vector.files["runtime.json"]));
  // Windows has no POSIX modes (and a Cloud computer, where this runs, is Linux).
  if (process.platform !== "win32") expect(fs.statSync(path.join(linkDir, "runtime.key")).mode & 0o777).toBe(0o600);
  expect(fs.readdirSync(linkDir).sort()).toEqual(["runtime.json", "runtime.key"]);
  // A restart after the claim asks nothing again.
  expect(await takeIdentity({ bootFile, linkDir, signal: new AbortController().signal, fetch: (() => Promise.reject(new Error("asked again"))) as typeof fetch })).toBe("kept");
});

test("kubelet's copy wins over a route that keeps saying 'not claimed yet', and the route stops asking", async () => {
  const { mount, linkDir, bootFile } = pod();
  let asks = 0;
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    asks++;
    // A long poll: 204 after a while, or the end when the runtime stops it.
    await new Promise((resolve, reject) => {
      const timer = setTimeout(resolve, 200);
      init.signal!.addEventListener("abort", () => (clearTimeout(timer), reject(init.signal!.reason)), { once: true });
    });
    return new Response(null, { status: 204 });
  }) as typeof fetch;
  const taking = takeIdentity({ bootFile, linkDir, signal: new AbortController().signal, fetch: fetchImpl, everyMs: 20 });
  await new Promise((r) => setTimeout(r, 300));
  fs.writeFileSync(path.join(mount, "runtime.key"), "kubelet key");
  fs.writeFileSync(path.join(mount, "runtime.json"), '{"runtime_id":"kubelet"}');
  expect(await taking).toBe("kubelet's copy");
  expect(fs.readFileSync(path.join(linkDir, "runtime.json"), "utf8")).toBe('{"runtime_id":"kubelet"}');
  const after = asks;
  await new Promise((r) => setTimeout(r, 500));
  expect(asks).toBe(after);
});

test("stopping it stops asking", async () => {
  const { linkDir, bootFile } = pod();
  const stop = new AbortController();
  let asks = 0;
  const taking = takeIdentity({ bootFile, linkDir, signal: stop.signal, fetch: (async () => (asks++, new Response(null, { status: 204 }))) as typeof fetch, everyMs: 20 });
  await new Promise((r) => setTimeout(r, 100));
  stop.abort();
  await expect(taking).rejects.toBeDefined();
  const after = asks;
  await new Promise((r) => setTimeout(r, 200));
  expect(asks).toBe(after);
  expect(fs.readdirSync(linkDir)).toEqual([]);
});

// Audit security-3#3: every wait between polls left its abort listener on the shared signal once its timer fired, so a
// warm pod waiting unclaimed for hours piled up one listener (and its closure) per 250 ms tick.
test("a warm pod waiting unclaimed holds one abort listener per pending wait, however many times it has polled", async () => {
  const { mount, linkDir, bootFile } = pod();
  const outer = new AbortController();
  // takeIdentity's combined signal (its own stop, and the caller's), the one every wait listens on.
  const any = AbortSignal.any.bind(AbortSignal);
  let combined: AbortSignal | undefined;
  vi.spyOn(AbortSignal, "any").mockImplementation((signals) => {
    const signal = any(signals);
    if ([...signals].includes(outer.signal)) combined ??= signal;
    return signal;
  });
  // Cloud holds the long poll until the runtime stops it: the pod is not claimed.
  const fetchImpl = ((_url: string, init: RequestInit) =>
    new Promise<Response>((_resolve, reject) => init.signal!.addEventListener("abort", () => reject(init.signal!.reason), { once: true }))) as typeof fetch;
  const taking = takeIdentity({ bootFile, linkDir, signal: outer.signal, fetch: fetchImpl, everyMs: 1 });
  // A few hundred polls of kubelet's copy.
  await new Promise((r) => setTimeout(r, 300));
  const listeners = getEventListeners(combined!, "abort").length;
  fs.writeFileSync(path.join(mount, "runtime.key"), "kubelet key");
  fs.writeFileSync(path.join(mount, "runtime.json"), '{"runtime_id":"kubelet"}');
  expect(await taking).toBe("kubelet's copy");
  // The poll's one pending wait, and at most one of the route's.
  expect(listeners).toBeLessThanOrEqual(2);
});
