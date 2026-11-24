// companion.list: the companions folder (~/.caveman/companions), where a chat saves the
// companions people make from an image (Settings > Appearance > Companion > Create). The
// runtime keeps the folder and its README (the guide the chat follows, so no engine carries
// it in its context by default) and hands each <id>.json over as written; the client checks
// and draws them (@caveman-app/shared/companion).
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

import { COMPANION_README, MAX_COMPANION_BYTES, MAX_COMPANIONS, companionGuide } from "@caveman-app/shared/companion";
import * as Effect from "effect/Effect";

import { type Handler, ProtocolError } from "./handlers.ts";

export const companionsFolder = (home: string) => path.join(home, ".caveman", "companions");

/** The folder, made with a current README, and its companion files by name (regular files only, each and their number capped). */
export async function listCompanions(folder: string): Promise<{ folder: string; files: Array<{ id: string; text?: string; problem?: string }> }> {
  await fs.promises.mkdir(folder, { recursive: true });
  const readme = path.join(folder, COMPANION_README);
  const guide = companionGuide(folder);
  if ((await fs.promises.readFile(readme, "utf8").catch(() => null)) !== guide) {
    const temp = `${readme}.${randomUUID()}.tmp`;
    await fs.promises.writeFile(temp, guide);
    await fs.promises.rename(temp, readme);
  }
  const names = (await fs.promises.readdir(folder)).filter((n) => n.endsWith(".json")).sort().slice(0, MAX_COMPANIONS);
  const files = await Promise.all(
    names.map(async (name) => {
      const file = path.join(folder, name);
      const stat = await fs.promises.lstat(file).catch(() => null);
      if (!stat?.isFile()) return null;
      const id = name.slice(0, -".json".length);
      if (stat.size > MAX_COMPANION_BYTES) return { id, problem: `it is ${stat.size} bytes; a companion file is at most ${MAX_COMPANION_BYTES}` };
      return { id, text: await fs.promises.readFile(file, "utf8") };
    }),
  );
  return { folder, files: files.filter((f) => f !== null) };
}

export const makeCompanionHandlers = (home: string): { readonly "companion.list": Handler<"companion.list"> } => ({
  "companion.list": () =>
    Effect.tryPromise({
      try: () => listCompanions(companionsFolder(home)),
      catch: (error) => new ProtocolError({ reason: "internal", message: `could not read the companions folder: ${(error as Error).message}` }),
    }),
});
