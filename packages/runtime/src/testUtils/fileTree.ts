// What the checkpoint model checks compare: a directory's files as git sees them.
import * as fs from "node:fs";
import * as path from "node:path";

/** Every file and symlink under `dir` (no .git), each as its mode and text or its link target, sorted by path. */
export function snapshotTree(
  dir: string,
  keep: (relativePath: string) => boolean = () => true,
): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (rel: string) => {
    for (const name of fs.readdirSync(path.join(dir, rel)).sort()) {
      const entry = rel === "" ? name : `${rel}/${name}`;
      if (entry === ".git") continue;
      const stat = fs.lstatSync(path.join(dir, entry));
      if (stat.isDirectory()) walk(entry);
      else if (keep(entry))
        out[entry] = stat.isSymbolicLink()
          ? `link -> ${fs.readlinkSync(path.join(dir, entry))}`
          : `${stat.mode & 0o111 ? "755" : "644"} ${fs.readFileSync(path.join(dir, entry), "utf8")}`;
    }
  };
  walk("");
  return out;
}

/** The paths whose entry differs between two snapshots, each as "path: before -> after". */
export function treeDiff(from: Record<string, string>, to: Record<string, string>): Array<string> {
  return [...new Set([...Object.keys(from), ...Object.keys(to)])]
    .sort()
    .filter((entry) => from[entry] !== to[entry])
    .map(
      (entry) =>
        `${entry}: ${JSON.stringify(from[entry] ?? "<absent>")} -> ${JSON.stringify(to[entry] ?? "<absent>")}`,
    );
}

/**
 * gitConfig.setup.ts pins core.filemode=false for every git the suite runs (Windows has no exec bit). A person's macOS
 * or Linux repository tracks it, and checkpoints must keep it: this gives git back its own default for this file.
 */
export function trackExecBit(): void {
  if (process.platform === "win32") return;
  const key = Object.keys(process.env).find(
    (name) => name.startsWith("GIT_CONFIG_KEY_") && process.env[name] === "core.filemode",
  );
  if (key !== undefined) process.env[key.replace("KEY", "VALUE")] = "true";
}
