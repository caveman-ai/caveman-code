import { createHash, generateKeyPairSync, randomBytes } from "node:crypto";

import { describe, expect, test } from "vitest";

import { BLOB_CHUNK_BYTES, BLOB_MAX_BYTES, BlobUnverified, getBlob, putBlob, type BlobRef } from "./blobs.ts";
import { CloudError, type Identity } from "./identity.ts";

const identity: Identity = { cloudUrl: "http://cloud.test", runtimeId: "rt-1", organizationId: "org-1", computerId: "c-1", key: generateKeyPairSync("ed25519").privateKey };
const state = { cloudUrl: identity.cloudUrl, token: "token-1" };
const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

/** Cloud's chunk routes over a Map, with every call it got. */
function chunkCloud(options: { routes?: boolean; refuse?: number } = {}) {
  const held = new Map<string, Buffer>();
  const calls: Array<{ method: string; sha: string; headers: Record<string, string> }> = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    const name = /\/journal\/blobs\/([0-9a-f]{64})$/.exec(url)![1]!;
    const method = init.method ?? "GET";
    calls.push({ method, sha: name, headers: init.headers as Record<string, string> });
    expect(url).toBe(`http://cloud.test/api/v1/code/runtime/sessions/s%201/journal/blobs/${name}`);
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer token-1");
    if (options.routes === false) return new Response("404 page not found", { status: 404 });
    if (method === "PUT") {
      if (options.refuse) return Response.json({ error: { code: "cave_code_blobs_full", message: "A chat's copy holds at most 256 MiB of large files." } }, { status: options.refuse });
      const body = Buffer.from(init.body as Uint8Array);
      if (sha(body) !== name) return Response.json({ error: { code: "cave_code_blob_mismatch" } }, { status: 400 });
      held.set(name, body);
      return new Response(null, { status: 204 });
    }
    const found = held.get(name);
    if (found === undefined) return Response.json({ error: { code: "cave_not_found" } }, { status: 404 });
    return new Response(method === "HEAD" ? null : found, { status: 200 });
  }) as unknown as typeof fetch;
  return { held, calls, fetchImpl };
}

describe("a copy's large parts as chunks (AC-08)", () => {
  test("go up in chunks of at most 8 MiB under the lease, each once, and come back whole", async () => {
    const cloud = chunkCloud();
    const bytes = randomBytes(2 * BLOB_CHUNK_BYTES + 1024);
    const ref = (await putBlob(identity, state, "s 1", "lease-1", bytes, cloud.fetchImpl))!;
    expect(ref).toEqual({ sha256: sha(bytes), bytes: bytes.length, chunks: [sha(bytes.subarray(0, BLOB_CHUNK_BYTES)), sha(bytes.subarray(BLOB_CHUNK_BYTES, 2 * BLOB_CHUNK_BYTES)), sha(bytes.subarray(2 * BLOB_CHUNK_BYTES))] });
    const puts = cloud.calls.filter((c) => c.method === "PUT");
    expect(puts.map((c) => c.sha)).toEqual(ref.chunks);
    for (const put of puts) expect(put.headers).toMatchObject({ "x-caveman-lease": "lease-1", "x-caveman-blob-bytes": String(bytes.length), "content-type": "application/octet-stream" });
    // Again: Cloud holds every chunk, so none is sent twice.
    cloud.calls.length = 0;
    expect(await putBlob(identity, state, "s 1", "lease-2", bytes, cloud.fetchImpl)).toEqual(ref);
    expect(cloud.calls.map((c) => c.method)).toEqual(["HEAD", "HEAD", "HEAD"]);
    expect((await getBlob(identity, state, "s 1", ref, cloud.fetchImpl)).equals(bytes)).toBe(true);
  });

  test("each chunk Cloud holds, sent or held already, is followed by the caller's turn to renew its lease, before the next chunk goes (m-8)", async () => {
    const cloud = chunkCloud();
    const bytes = randomBytes(2 * BLOB_CHUNK_BYTES + 1024);
    const seen: Array<string> = [];
    const onChunk = async () => void seen.push(cloud.calls.map((c) => c.method).join(","));
    await putBlob(identity, state, "s 1", "lease-1", bytes, cloud.fetchImpl, undefined, onChunk);
    expect(seen).toEqual(["HEAD,PUT", "HEAD,PUT,HEAD,PUT", "HEAD,PUT,HEAD,PUT,HEAD,PUT"]);
    seen.length = 0;
    cloud.calls.length = 0;
    await putBlob(identity, state, "s 1", "lease-1", bytes, cloud.fetchImpl, undefined, onChunk);
    expect(seen).toEqual(["HEAD", "HEAD,HEAD", "HEAD,HEAD,HEAD"]);
  });

  test("a Cloud without the routes answers no ref (the copy goes without, as before); one that refuses says why", async () => {
    expect(await putBlob(identity, state, "s 1", "lease-1", randomBytes(1024), chunkCloud({ routes: false }).fetchImpl)).toBeUndefined();
    const refused = await putBlob(identity, state, "s 1", "lease-1", randomBytes(1024), chunkCloud({ refuse: 413 }).fetchImpl).catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(CloudError);
    expect(refused).toMatchObject({ status: 413, code: "cave_code_blobs_full" });
  });

  test("a chunk that is missing or not what was copied, or a whole that is not, never comes back", async () => {
    const cloud = chunkCloud();
    const bytes = randomBytes(BLOB_CHUNK_BYTES + 10);
    const ref = (await putBlob(identity, state, "s 1", "lease-1", bytes, cloud.fetchImpl))!;
    const flip = (b: Buffer) => Buffer.concat([b.subarray(0, -1), Buffer.from([b.at(-1)! ^ 1])]);
    cloud.held.set(ref.chunks[1]!, flip(cloud.held.get(ref.chunks[1]!)!));
    await expect(getBlob(identity, state, "s 1", ref, cloud.fetchImpl)).rejects.toThrow(BlobUnverified);
    await expect(getBlob(identity, state, "s 1", ref, cloud.fetchImpl)).rejects.toThrow(/not what was copied/);
    cloud.held.delete(ref.chunks[1]!);
    await expect(getBlob(identity, state, "s 1", ref, cloud.fetchImpl)).rejects.toThrow(/is not with Caveman \(/);
    await putBlob(identity, state, "s 1", "lease-1", bytes, cloud.fetchImpl);
    const lying: BlobRef = { ...ref, sha256: sha(Buffer.from("other")) };
    await expect(getBlob(identity, state, "s 1", lying, cloud.fetchImpl)).rejects.toThrow(/its work in progress is not what was copied/);
  });

  test("a ref no writer could have made is refused before a chunk is asked for: whoever held the copy last wrote it", async () => {
    const cloud = chunkCloud();
    const bytes = randomBytes(1024);
    const ref = (await putBlob(identity, state, "s 1", "lease-1", bytes, cloud.fetchImpl))!;
    cloud.calls.length = 0;
    const refused: ReadonlyArray<unknown> = [
      // One valid chunk named ten times: each checks, and the reader would hold ten of them before the whole fails.
      { ...ref, chunks: Array.from({ length: 10 }, () => ref.chunks[0]!) },
      { ...ref, bytes: 10 * BLOB_CHUNK_BYTES, chunks: Array.from({ length: 10 }, () => ref.chunks[0]!) },
      { ...ref, bytes: BLOB_MAX_BYTES + 1, chunks: Array.from({ length: 9 }, () => ref.chunks[0]!) },
      { ...ref, bytes: 0, chunks: [] },
      { ...ref, bytes: 1.5 },
      { ...ref, chunks: ["../../holdings"] },
      { ...ref, chunks: [ref.chunks[0]!.toUpperCase()] },
      { ...ref, sha256: "nope" },
      { ...ref, chunks: "not a list" },
    ];
    for (const bad of refused) await expect(getBlob(identity, state, "s 1", bad as BlobRef, cloud.fetchImpl), JSON.stringify(bad)).rejects.toThrow(BlobUnverified);
    expect(cloud.calls).toEqual([]);
    // A chunk longer than any chunk is never read on: the ref names 1 KiB, Cloud hands back more.
    cloud.held.set(ref.chunks[0]!, randomBytes(BLOB_CHUNK_BYTES + 1));
    await expect(getBlob(identity, state, "s 1", ref, cloud.fetchImpl)).rejects.toThrow(BlobUnverified);
  });
});
