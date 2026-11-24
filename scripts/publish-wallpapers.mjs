// Full artwork lives outside Vite's input tree. Verify every immutable asset before publishing it.
import { readFile, readdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import path from "node:path";

const root = fileURLToPath(new URL("../", import.meta.url));
const catalog = JSON.parse(
  await readFile(path.join(root, "apps/web/src/state/wallpaper-library.json"), "utf8"),
);
const directory = path.join(root, "wallpapers/images");
const files = await readdir(directory);
const listed = new Set();
let total = 0;
for (const art of catalog) {
  if (!/^[a-z0-9-]+-[a-f0-9]{16}\.webp$/.test(art.file) || listed.has(art.file))
    throw new Error(`Invalid asset: ${art.file}`);
  listed.add(art.file);
  const bytes = await readFile(path.join(directory, art.file));
  const sha = createHash("sha256").update(bytes).digest("hex");
  if (
    bytes.length !== art.bytes ||
    sha !== art.sha256 ||
    !art.file.endsWith(`-${sha.slice(0, 16)}.webp`)
  )
    throw new Error(`Asset checksum mismatch: ${art.file}`);
  if (bytes.toString("ascii", 0, 4) !== "RIFF" || bytes.toString("ascii", 8, 12) !== "WEBP")
    throw new Error(`Invalid WebP: ${art.file}`);
  if (
    !art.credit.author ||
    !/^https:\/\//.test(art.credit.sourceUrl) ||
    !/^https:\/\//.test(art.credit.licenseUrl)
  )
    throw new Error(`Missing credit: ${art.file}`);
  total += bytes.length;
}
if (files.some((file) => !listed.has(file))) throw new Error("Unlisted wallpaper asset");
console.log(`Verified ${catalog.length} wallpapers, ${total} bytes.`);

if (process.argv.includes("--upload")) {
  const account = process.env.R2_ACCOUNT_ID;
  if (!account || !process.env.AWS_ACCESS_KEY_ID || !process.env.AWS_SECRET_ACCESS_KEY)
    throw new Error("Wallpaper publishing credentials are missing.");
  const result = spawnSync(
    "aws",
    [
      "s3",
      "sync",
      directory,
      "s3://caveman-downloads/code/wallpapers/v1/",
      "--endpoint-url",
      `https://${account}.r2.cloudflarestorage.com`,
      "--content-type",
      "image/webp",
      "--cache-control",
      "public, max-age=31536000, immutable",
      "--only-show-errors",
    ],
    { stdio: "inherit" },
  );
  if (result.status !== 0) process.exit(result.status ?? 1);
}
