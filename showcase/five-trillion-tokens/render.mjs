#!/usr/bin/env node
// Films index.html into a video. The page draws any frame of the take from its time alone and renders its own
// sound (`window.take`), so this opens it in a headless Chrome, asks for every frame in turn and for the sound,
// and has ffmpeg join them. Needs Chrome (or CHROME=/path/to/chrome) and ffmpeg; nothing from npm.
//
//   node showcase/five-trillion-tokens/render.mjs                    out/five-trillion-tokens.mp4, and its last frame as a PNG
//   node showcase/five-trillion-tokens/render.mjs --out ~/Desktop    somewhere else (out/ is git-ignored)
//   node showcase/five-trillion-tokens/render.mjs --stills 1,5.2,11  only those seconds, as PNGs
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const NAME = "five-trillion-tokens";
const here = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const option = (name) => {
  const at = args.indexOf(`--${name}`);
  return at < 0 ? undefined : args[at + 1];
};
const outDir = path.resolve(option("out") ?? path.join(here, "out"));
const stills = option("stills")?.split(",").map(Number);

const chrome = [
  process.env.CHROME,
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
].find((file) => file && fs.existsSync(file));
if (!chrome) {
  console.error("render: no Chrome found; set CHROME to its binary.");
  process.exit(1);
}

const profile = fs.mkdtempSync(path.join(os.tmpdir(), `${NAME}-`));
const browser = spawn(
  chrome,
  [
    "--headless=new",
    "--remote-debugging-port=0",
    `--user-data-dir=${profile}`,
    "--no-first-run",
    "--mute-audio",
    "about:blank",
  ],
  { stdio: ["ignore", "ignore", "pipe"] },
);

try {
  // Chrome says on stderr where its debugger listens.
  const port = await new Promise((found, failed) => {
    let said = "";
    browser.stderr.on("data", (chunk) => {
      said += chunk;
      const at = said.match(/DevTools listening on ws:\/\/[^:]+:(\d+)\//);
      if (at) found(at[1]);
    });
    browser.once("error", failed);
    browser.once("exit", () => failed(new Error(`Chrome quit before it listened:\n${said}`)));
  });
  const tab = await (
    await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: "PUT" })
  ).json();
  const socket = new WebSocket(tab.webSocketDebuggerUrl);
  await new Promise((opened, failed) => {
    socket.addEventListener("open", opened);
    socket.addEventListener("error", () => failed(new Error("no connection to the tab")));
  });

  const waiting = new Map();
  let sent = 0;
  let thrown = ""; // what the page threw, if it did
  socket.addEventListener("message", ({ data }) => {
    const message = JSON.parse(data);
    if (message.method === "Runtime.exceptionThrown") {
      const details = message.params.exceptionDetails;
      thrown = details.exception?.description ?? details.text;
    }
    waiting.get(message.id)?.(message);
    waiting.delete(message.id);
  });
  const send = (method, params = {}) =>
    new Promise((answered, failed) => {
      const id = ++sent;
      waiting.set(id, ({ result, error }) =>
        error ? failed(new Error(error.message)) : answered(result),
      );
      socket.send(JSON.stringify({ id, method, params }));
    });
  // An expression's value in the page; a promise is waited for.
  const run = async (expression) => {
    const { result, exceptionDetails } = await send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (exceptionDetails)
      throw new Error(exceptionDetails.exception?.description ?? exceptionDetails.text);
    return result.value;
  };

  await send("Runtime.enable");
  await send("Page.navigate", { url: pathToFileURL(path.join(here, "index.html")).href });
  for (let tries = 0; !(await run("typeof window.take === 'object'")); tries++) {
    if (thrown || tries > 100)
      throw new Error(`the page never offered its take${thrown ? `:\n${thrown}` : ""}`);
    await new Promise((later) => setTimeout(later, 50));
  }
  const { LENGTH, FPS } = await run("({ LENGTH: take.LENGTH, FPS: take.FPS })");
  const frame = async (t) =>
    Buffer.from(
      await run(
        `(take.film(${t}), document.getElementById("frame").toDataURL("image/png").slice(22))`,
      ),
      "base64",
    );
  fs.mkdirSync(outDir, { recursive: true });

  if (stills) {
    for (const t of stills)
      fs.writeFileSync(
        path.join(outDir, `${NAME}-${t.toFixed(2).padStart(5, "0")}.png`),
        await frame(t),
      );
    console.log(`${stills.length} stills in ${outDir}`);
  } else {
    const wav = path.join(profile, "sound.wav");
    fs.writeFileSync(wav, Buffer.from(await run("take.record()"), "base64"));
    const video = path.join(outDir, `${NAME}.mp4`);
    // H.264 that plays everywhere (4:2:0, BT.709), at a quality that keeps the pixels square after a site encodes
    // it again.
    const reads = `-y -loglevel error -f image2pipe -framerate ${FPS} -c:v png -i -`.split(" ");
    const writes = [
      "-vf scale=in_range=pc:out_range=tv:out_color_matrix=bt709,format=yuv420p",
      "-colorspace bt709 -color_primaries bt709 -color_trc bt709",
      "-c:v libx264 -preset slow -crf 14 -c:a aac -b:a 256k -movflags +faststart -shortest",
    ].flatMap((flags) => flags.split(" "));
    const ffmpeg = spawn("ffmpeg", [...reads, "-i", wav, ...writes, video], {
      stdio: ["pipe", "inherit", "inherit"],
    });
    const encoded = new Promise((done, failed) => {
      ffmpeg.once("error", () => failed(new Error("ffmpeg did not start; is it installed?")));
      ffmpeg.once("exit", (code) => (code ? failed(new Error(`ffmpeg failed (${code})`)) : done()));
    });
    // ffmpeg dying is told by `encoded`, awaited below: until then neither it nor the broken pipe may go unheard
    // and skip the cleanup.
    encoded.catch(() => {});
    ffmpeg.stdin.on("error", () => {});
    const count = Math.round(LENGTH * FPS);
    let last;
    for (let i = 0; i < count; i++) {
      last = await frame(i / FPS);
      const room = ffmpeg.stdin.write(last);
      if (!room)
        await Promise.race([
          new Promise((drained) => ffmpeg.stdin.once("drain", drained)),
          encoded,
        ]);
      if (i % FPS === 0) process.stdout.write(`\r${i / FPS} of ${Math.round(LENGTH)} s`);
    }
    ffmpeg.stdin.end();
    await encoded;
    fs.writeFileSync(path.join(outDir, `${NAME}.png`), last);
    console.log(`\r${video}`);
  }
  socket.close();
} finally {
  // Chrome writes to its profile until it is gone: wait for that before removing it.
  if (browser.exitCode === null && browser.signalCode === null) {
    const gone = new Promise((exited) => browser.once("exit", exited));
    browser.kill();
    await gone;
  }
  fs.rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
