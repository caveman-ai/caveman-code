import type { PrDetail, PrGuideResult } from "@caveman-app/session-protocol";
import type { Client } from "@caveman-app/session-protocol/client";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The cache's hooks read it with useSyncExternalStore; a static render (no DOM) needs its server snapshot.
vi.mock("react", async (importOriginal) => {
  const react = await importOriginal<typeof import("react")>();
  return { ...react, useSyncExternalStore: <T,>(s: (l: () => void) => () => void, get: () => T, server?: () => T) => react.useSyncExternalStore(s, get, server ?? get) };
});
import { filesReadAt, invalidatePr, pollGuide, readPrFile, usePrDetail, usePrGuide } from "./data.ts";

/** What a hook shows now, as a page drawn this moment would. */
function shown<T>(hook: () => T): T {
  let value: T | undefined;
  renderToStaticMarkup(createElement(() => ((value = hook()), null)));
  return value!;
}
/** A host call that answers when the test says. */
function later<T>(answer: () => T) {
  let land!: () => void;
  const promise = new Promise<T>((resolve) => (land = () => resolve(answer())));
  return { promise, land };
}
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
const QUEUE = { prs: [], viewers: {}, errors: [] };

describe("filesReadAt", () => {
  it("reads Files at the head and revision of the patch on screen", () => {
    expect(filesReadAt({ head_sha: "abc", revision: "3", files: [], omitted: [] })).toEqual({ head: "abc", revision: "3" });
    expect(filesReadAt(undefined)).toEqual({ head: "", revision: undefined });
  });

  it("keeps a patch no head vouches for under the patch itself: the same patch read again, the same; a push's, another", () => {
    // pr.diff names no head where the host cannot say (Bitbucket) or a push landed mid-read. The page's own head comes
    // from pr.get, a separate read that may already be the next push's: marks kept under it would sit on that push.
    const file = (patch: string) => ({ path: "src/a.ts", status: "modified" as const, additions: 1, deletions: 1, patch });
    const read = (patch: string) => filesReadAt({ files: [file(patch)], omitted: [] });
    const first = read("@@ -1 +1 @@\n-a\n+b\n");
    expect(first.head).toMatch(/^patch:[0-9a-z]+$/);
    expect(read("@@ -1 +1 @@\n-a\n+b\n")).toEqual(first);
    expect(read("@@ -1 +1 @@\n-a\n+c\n").head).not.toBe(first.head);
    expect(filesReadAt({ files: [file("@@ -1 +1 @@\n-a\n+b\n")], omitted: ["big.lock"] }).head).not.toBe(first.head);
  });
});

describe("readPrFile", () => {
  it("reads a file at the revision its patch was read at, and as the pull request is now without one", async () => {
    const asked: Array<unknown> = [];
    const client = { call: (method: string, params: unknown) => (asked.push([method, params]), Promise.resolve({ old: "", new: "" })) } as unknown as Client;
    const pr = { project_id: "p", number: 7 };
    const file = { path: "src/x.ts", status: "modified" } as const;

    await readPrFile(pr, "3", file)(client);
    await readPrFile(pr, undefined, file)(client);

    expect(asked).toEqual([
      ["pr.file", { project_id: "p", number: 7, path: "src/x.ts", status: "modified", revision: "3" }],
      ["pr.file", { project_id: "p", number: 7, path: "src/x.ts", status: "modified" }],
    ]);
  });
});

describe("pollGuide", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("keeps reading a guide being written through a failed read, and stops once it lands", async () => {
    const replies = [
      () => Promise.resolve({ guide: null, running: true, head_sha: "abc" }),
      () => Promise.reject(new Error("GitHub did not answer")),
      () => Promise.resolve({ guide: null, running: true, head_sha: "abc" }),
      () => Promise.resolve({ guide: null, running: false, head_sha: "abc" }),
    ];
    let guideReads = 0;
    const client = {
      call: (method: string) => (method === "pr.guide" ? replies[guideReads++]!() : Promise.resolve({ prs: [], viewers: {}, errors: [] })),
    } as unknown as Client;
    const pr = { project_id: "p", number: 41 };

    invalidatePr(client, pr, "guide");
    const stop = pollGuide(client, pr);
    await vi.advanceTimersByTimeAsync(0);
    expect(guideReads).toBe(1);
    await vi.advanceTimersByTimeAsync(2500);
    expect(guideReads).toBe(2); // failed
    await vi.advanceTimersByTimeAsync(2500);
    expect(guideReads).toBe(3); // still running
    await vi.advanceTimersByTimeAsync(2500);
    expect(guideReads).toBe(4); // ended
    await vi.advanceTimersByTimeAsync(30_000);
    expect(guideReads).toBe(4);
    stop();
  });

  it("stops reading when nobody watches", async () => {
    let guideReads = 0;
    const client = {
      call: (method: string) => {
        if (method === "pr.guide") guideReads++;
        return Promise.resolve(method === "pr.guide" ? { guide: null, running: true } : { prs: [], viewers: {}, errors: [] });
      },
    } as unknown as Client;
    const pr = { project_id: "p", number: 42 };

    invalidatePr(client, pr, "guide");
    const stop = pollGuide(client, pr);
    await vi.advanceTimersByTimeAsync(2500);
    expect(guideReads).toBe(2);
    stop();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(guideReads).toBe(2);
  });
});

describe("a forced read (a write's refresh, a guide run asked for)", () => {
  it("shows a second write's change even when it lands while the first write's read is still out", async () => {
    // The host: the files marked viewed, read when pr.get is asked (as GitHub does).
    const host = new Set<string>();
    const reads: Array<{ land: () => void }> = [];
    const client = {
      call: (method: string) => {
        if (method !== "pr.get") return Promise.resolve(QUEUE);
        const snapshot = { files: ["a.ts", "b.ts"].map((path) => ({ path, viewed: host.has(path) })) };
        const read = later(() => snapshot);
        reads.push(read);
        return read.promise;
      },
    } as unknown as Client;
    const pr = { project_id: "p", number: 51 };
    const viewed = () => (shown(() => usePrDetail(client, pr).value) as PrDetail | undefined)?.files.filter((f) => f.viewed).map((f) => f.path);

    host.add("a.ts");
    invalidatePr(client, pr, "detail");
    // Viewed on b.ts lands while a.ts's refresh is still out: b.ts's refresh is a read of its own.
    host.add("b.ts");
    invalidatePr(client, pr, "detail");
    expect(reads).toHaveLength(2);
    // The new answer first, then the one that left before b.ts was viewed: it must not undo b.ts.
    reads[1]!.land();
    await settle();
    expect(viewed()).toEqual(["a.ts", "b.ts"]);
    reads[0]!.land();
    await settle();
    expect(viewed()).toEqual(["a.ts", "b.ts"]);
  });

  it("starts the guide run asked for while a plain read of the guide is out, and shows the run", async () => {
    const calls: Array<Record<string, unknown>> = [];
    const answers: Array<{ land: () => void }> = [];
    const client = {
      call: (method: string, params: Record<string, unknown>) => {
        if (method !== "pr.guide") return Promise.resolve(QUEUE);
        calls.push(params);
        const answer = later(() => ({ guide: null, running: params.generate === true, head_sha: "h1" }));
        answers.push(answer);
        return answer.promise;
      },
    } as unknown as Client;
    const pr = { project_id: "p", number: 52 };
    const guide = () => shown(() => usePrGuide(client, pr, { enabled: false }));

    // A read of the guide is out (the page's mount, a hover); the person asks for the guide meanwhile.
    invalidatePr(client, pr, "guide");
    guide().generate();
    expect(calls.map((p) => p.generate === true)).toEqual([false, true]);
    answers[1]!.land();
    await settle();
    answers[0]!.land();
    await settle();
    expect((guide().value as PrGuideResult | undefined)?.running).toBe(true);
  });
});
