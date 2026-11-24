import { test } from "node:test";
import assert from "node:assert/strict";
import worker from "./edge.mjs";

const path = "/code/wallpapers/v1/night-0123456789abcdef.webp";
const origin = "https://download.caveman.so";
function fixture() {
  const reads = [];
  const object = { body: new Uint8Array([1, 2, 3]), size: 3, httpEtag: '"picture"' };
  return {
    reads,
    env: {
      WALLPAPERS: {
        get: async (key) => {
          reads.push(["get", key]);
          return object;
        },
        head: async (key) => {
          reads.push(["head", key]);
          return object;
        },
      },
    },
  };
}

test("wallpaper GET returns image bytes and anonymous read headers", async () => {
  const { reads, env } = fixture();
  const response = await worker.fetch(new Request(origin + path), env);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Access-Control-Allow-Origin"), "*");
  assert.equal(response.headers.get("Content-Type"), "image/webp");
  assert.equal(response.headers.get("Content-Length"), "3");
  assert.deepEqual([...new Uint8Array(await response.arrayBuffer())], [1, 2, 3]);
  assert.deepEqual(reads, [["get", path.slice(1)]]);
});

test("other downloads and malformed image paths receive no CORS grant or bucket access", async () => {
  const { reads, env } = fixture();
  for (const target of [
    "/code/mac/latest-mac.yml",
    "/private/file.webp",
    "/code/wallpapers/v1/other.json",
    "/code/wallpapers/v1/name.webp",
  ]) {
    const response = await worker.fetch(new Request(origin + target), env);
    assert.equal(response.status, 404);
    assert.equal(response.headers.get("Access-Control-Allow-Origin"), null);
  }
  assert.equal(reads.length, 0);
});

test("HEAD uses metadata without reading image body", async () => {
  const { reads, env } = fixture();
  const response = await worker.fetch(new Request(origin + path, { method: "HEAD" }), env);
  assert.equal(await response.text(), "");
  assert.equal(response.headers.get("Content-Length"), "3");
  assert.deepEqual(reads, [["head", path.slice(1)]]);
});

test("preflight permits only reads and writes never reach storage", async () => {
  const { reads, env } = fixture();
  const preflight = await worker.fetch(new Request(origin + path, { method: "OPTIONS" }), env);
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get("Access-Control-Allow-Methods"), "GET, HEAD, OPTIONS");
  for (const method of ["POST", "PUT", "DELETE"]) {
    assert.equal((await worker.fetch(new Request(origin + path, { method }), env)).status, 405);
  }
  assert.equal(reads.length, 0);
});

test("a missing wallpaper returns a readable 404", async () => {
  const response = await worker.fetch(new Request(origin + path), {
    WALLPAPERS: { get: async () => null },
  });
  assert.equal(response.status, 404);
  assert.equal(response.headers.get("Access-Control-Allow-Origin"), "*");
});
