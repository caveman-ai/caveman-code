// ), scripts/mock-update-server.ts @ 67eebaca23, without Effect: serves a folder as an update
// feed on 127.0.0.1, laid out as download.caveman.so is (code/mac/latest-mac.yml and the zips beside it,
// code/nightly/mac/... for Nightly), so a build made without --release can update against it:
//   node apps/desktop/scripts/mock-update-server.mjs <root> [port]
//   CAVEMAN_UPDATE_FEED_URL=http://127.0.0.1:<port>/code/mac open "Caveman Code.app"
// Only files inside the root, after symlinks, are served; anything else is a 404.
import { createReadStream, realpathSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { isAbsolute, relative, resolve, sep } from "node:path";

const outside = (root, file) => {
  const rel = relative(root, file);
  // Another drive on Windows makes the relative path absolute.
  return rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel);
};

/** The file a request names inside `root` (a real path), or undefined. */
export function servedFile(root, url) {
  let path;
  try {
    path = decodeURIComponent((url ?? "/").split("?", 1)[0]);
  } catch {
    return undefined;
  }
  if (path.includes("\0")) return undefined;
  const file = resolve(root, `.${path.startsWith("/") ? path : `/${path}`}`);
  if (outside(root, file)) return undefined;
  try {
    const real = realpathSync(file);
    if (outside(root, real) || !statSync(real).isFile()) return undefined;
    return real;
  } catch {
    return undefined;
  }
}

/** Starts serving `root`; resolves with the server once it listens (port 0 picks one). */
export function serveUpdates(rootInput, port = 0, log = () => undefined) {
  const root = realpathSync(rootInput);
  const server = createServer((request, response) => {
    const file = servedFile(root, request.url);
    log(`${request.method} ${request.url} -> ${file ?? 404}`);
    if (file === undefined || (request.method !== "GET" && request.method !== "HEAD")) {
      response.writeHead(404, { "content-type": "text/plain" }).end("Not Found");
      return;
    }
    const { size } = statSync(file);
    response.writeHead(200, {
      "content-length": size,
      "content-type": file.endsWith(".yml") ? "text/yaml" : "application/octet-stream",
    });
    if (request.method === "HEAD") return response.end();
    createReadStream(file).pipe(response);
  });
  return new Promise((done, fail) => {
    server.once("error", fail);
    server.listen(port, "127.0.0.1", () => done(server));
  });
}

if (import.meta.main) {
  const [root, port] = process.argv.slice(2);
  if (!root) {
    console.error("usage: mock-update-server.mjs <root> [port]");
    process.exit(2);
  }
  const server = await serveUpdates(root, Number(port ?? 3000), (line) => console.log(line));
  console.log(`serving ${realpathSync(root)} on http://127.0.0.1:${server.address().port}`);
}
