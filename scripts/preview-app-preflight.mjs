// Keep this dependency-free: it must explain an incomplete checkout even before pnpm install.
// @ts-check
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import { createRequire, findPackageJSON } from "node:module";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

/** JSONC, as tsconfig accepts it: preserve strings while removing comments and trailing commas. */
function configJson(/** @type {string} */ text) {
  const strings = /"(?:\\.|[^"\\])*"/g;
  const tokens = /"(?:\\.|[^"\\])*"|\/\*[\s\S]*?\*\/|\/\/[^\r\n]*/g;
  const uncommented = text
    .replace(/^\uFEFF/, "")
    .replace(tokens, (token) => (token.startsWith('"') ? token : " "));
  return JSON.parse(
    uncommented.replace(new RegExp(`${strings.source}|,\\s*(?=[}\\]])`, "g"), (token) =>
      token.startsWith('"') ? token : "",
    ),
  );
}

/** Check only; never create a home, restore files, or start a server. Undefined means ready to launch. */
export function previewPreflight(/** @type {string} */ root) {
  const git = spawnSync("git", ["ls-files", "--deleted", "-z"], {
    cwd: root,
    encoding: "utf8",
    timeout: 5_000,
    maxBuffer: 4 * 1024 * 1024,
  });
  const staged = spawnSync("git", ["diff", "--cached", "--name-only", "--diff-filter=D", "-z"], {
    cwd: root,
    encoding: "utf8",
    timeout: 5_000,
    maxBuffer: 4 * 1024 * 1024,
  });
  const deleted = new Set([
    ...(git.status === 0 ? git.stdout.split("\0") : []),
    ...(staged.status === 0 ? staged.stdout.split("\0") : []),
  ]);
  /** @type {Map<string, string>} */
  const problems = new Map();
  const inspect = new Set();
  let install = false;
  const relative = (/** @type {string} */ file) =>
    path.relative(root, file).split(path.sep).join("/");
  const missing = (/** @type {string} */ file, dependency = false) => {
    const name = relative(file);
    if (dependency) install = true;
    else inspect.add(name);
    problems.set(
      name,
      `missing${deleted.has(name) ? " (deleted from this checkout)" : ""}${dependency ? "; run pnpm install" : ""}`,
    );
  };
  const fileExists = (/** @type {string} */ file, dependency = false) => {
    try {
      // lstat distinguishes an absent path from local work such as a dangling symlink.
      fs.lstatSync(file);
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        missing(file, dependency);
        return false;
      }
      problems.set(relative(file), "present but broken (cannot inspect file)");
      if (!dependency) inspect.add(relative(file));
      return false;
    }
    try {
      if (!fs.statSync(file).isFile()) throw new Error("not a regular file");
      fs.accessSync(file, fs.constants.R_OK);
      return true;
    } catch {
      problems.set(
        relative(file),
        `present but broken (unreadable file or dangling symlink)${dependency ? "; run pnpm install" : ""}`,
      );
      if (dependency) install = true;
      else inspect.add(relative(file));
      return false;
    }
  };
  const readJson = (/** @type {string} */ file, jsonc = false) => {
    if (!fileExists(file)) return;
    try {
      const value = jsonc
        ? configJson(fs.readFileSync(file, "utf8"))
        : JSON.parse(fs.readFileSync(file, "utf8"));
      if (!value || typeof value !== "object" || Array.isArray(value))
        throw new Error("expected an object");
      return value;
    } catch (error) {
      inspect.add(relative(file));
      problems.set(
        relative(file),
        `cannot read config: ${error instanceof Error ? error.message : String(error)}; fix this file`,
      );
    }
  };
  const configs = new Set();
  const active = new Set();
  const checkConfig = (/** @type {string} */ file) => {
    if (active.has(file)) {
      problems.set(relative(file), "circular tsconfig extends; fix this file");
      return;
    }
    if (configs.has(file)) return;
    configs.add(file);
    const config = readJson(file, true);
    if (!config || config.extends === undefined) return;
    active.add(file);
    for (const base of Array.isArray(config.extends) ? config.extends : [config.extends]) {
      if (typeof base !== "string" || !base) {
        problems.set(relative(file), "invalid tsconfig extends; fix this file");
        continue;
      }
      if (base.startsWith(".") || path.isAbsolute(base)) {
        const target = path.resolve(path.dirname(file), base);
        const candidates = [target, `${target}.json`, path.join(target, "tsconfig.json")];
        checkConfig(
          candidates.find((candidate) => {
            try {
              const entry = fs.lstatSync(candidate);
              return entry.isFile() || entry.isSymbolicLink();
            } catch {
              return false;
            }
          }) ?? (path.extname(target) ? target : `${target}.json`),
        );
      } else {
        // Known limitation, kept on purpose: a bare package name ("expo/tsconfig.base") is resolved the way Node
        // resolves modules, so a package whose main entry resolves first is read as that file, not its tsconfig.
        // No config the preview checks extends a package (only apps/mobile does, and the preview never reads it);
        // resolve tsconfig's own way (the package's "tsconfig" field) before a package-name extends is ever added.
        const require = createRequire(file);
        let resolved;
        for (const candidate of [base, `${base}.json`, `${base}/tsconfig.json`]) {
          try {
            resolved = require.resolve(candidate);
            break;
          } catch {
            /* Try the next TypeScript config resolution form. */
          }
        }
        if (resolved) checkConfig(resolved);
        else {
          install = true;
          problems.set(
            relative(file),
            `cannot resolve extends ${JSON.stringify(base)}; run pnpm install`,
          );
        }
      }
    }
    active.delete(file);
  };
  const packages = new Set();
  const manifests = new Map();
  const checkPackage = (/** @type {string} */ dir) => {
    if (packages.has(dir)) return;
    packages.add(dir);
    checkConfig(path.join(dir, "tsconfig.json"));
    const manifest = readJson(path.join(dir, "package.json"));
    if (manifest) manifests.set(dir, manifest);
    // pnpm's local links identify the workspace packages these two entrypoints import, including transitive ones.
    for (const [name, version] of Object.entries({
      ...manifest?.dependencies,
      ...manifest?.devDependencies,
    })) {
      const link = path.join(dir, "node_modules", name);
      if (typeof version !== "string" || !version.startsWith("workspace:")) {
        try {
          // Node's package lookup follows node_modules ancestors and symlinks. Resolve the
          // manifest, not the root export: @types and subpath-only packages have no root entry.
          const manifestFile = findPackageJSON(name, pathToFileURL(path.join(dir, "package.json")));
          if (!manifestFile || !fileExists(manifestFile, true)) missing(link, true);
        } catch {
          missing(link, true);
        }
        continue;
      }
      let target;
      try {
        // readlink still names the local package when its whole directory was deleted from this checkout.
        target = path.resolve(path.dirname(link), fs.readlinkSync(link));
      } catch {
        try {
          target = fs.realpathSync(link);
        } catch {
          missing(link, true);
          continue;
        }
      }
      const rel = path.relative(root, target);
      if (rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
        problems.set(
          relative(link),
          "workspace link points outside this checkout; run pnpm install",
        );
        install = true;
      } else checkPackage(target);
    }
  };

  readJson(path.join(root, "package.json"));
  const index = path.join(root, "apps/web/index.html");
  if (fileExists(index)) {
    try {
      const html = fs.readFileSync(index, "utf8").replace(/<!--[\s\S]*?-->/g, "");
      for (const tag of html.matchAll(/<script\b[^>]*>/gi)) {
        const attribute = /\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(tag[0]);
        const src = attribute?.[1] ?? attribute?.[2] ?? attribute?.[3];
        if (!src || /^(?:[a-z]+:|\/\/)/i.test(src)) continue;
        const target = path.resolve(path.dirname(index), src.replace(/^\//, "").split(/[?#]/)[0]);
        if (!fileExists(target))
          problems.set(
            relative(target),
            `${problems.get(relative(target))}; referenced by apps/web/index.html`,
          );
      }
    } catch {
      inspect.add(relative(index));
      problems.set(relative(index), "present but broken (cannot read HTML)");
    }
  }
  fileExists(path.join(root, "apps/web/src/main.tsx"));
  fileExists(path.join(root, "apps/web/vite.config.ts"));
  fileExists(path.join(root, "packages/runtime/src/bin.ts"));
  checkPackage(path.join(root, "apps/web"));
  checkPackage(path.join(root, "packages/runtime"));
  const vite = path.join(root, "apps/web/node_modules/vite");
  if (!fs.existsSync(vite)) missing(vite, true);
  else fileExists(path.join(vite, "bin/vite.js"), true);

  // A deletion alone is not corruption. Only scan when Git has deleted paths, and only
  // reject those still imported by remaining sources in the reachable workspace packages.
  // This avoids a compiler/build on every launch and permits unused or committed removals.
  const deletedSources = new Set(
    [...deleted].filter((file) =>
      [...packages].some((dir) => file.startsWith(`${relative(dir)}/`)),
    ),
  );
  if (deletedSources.size) {
    const hints = new Set(
      [...deletedSources].map((file) => {
        // Strip extensions after the name, never a dotfile's leading dot: ".gitignore" must not become "", an
        // empty pattern that git grep -F matches in every file, turning one deletion into a scan of the whole tree.
        const stem = path.basename(file).replace(/(?!^)\..*$/, "");
        return stem === "index" ? path.basename(path.dirname(file)) : stem;
      }),
    );
    hints.delete("");
    if ([...deletedSources].some((file) => /^index\./.test(path.basename(file)))) {
      // A directory import may be just "." or "..", with no basename to prefilter on.
      hints.add('".');
      hints.add("'.");
    }
    for (const [dir, manifest] of manifests) {
      if (
        [...deletedSources].some((file) => file.startsWith(`${relative(dir)}/`)) &&
        typeof manifest.name === "string"
      )
        hints.add(manifest.name);
    }
    // Git filters candidates in native code before JS reads/tokenizes them. In a large
    // checkout, walking every runtime source for one deleted web file dominates launch time.
    const sources = spawnSync(
      "git",
      [
        "grep",
        "-l",
        "-z",
        "-I",
        "--untracked",
        "-F",
        ...[...hints].flatMap((hint) => ["-e", hint]),
        "--",
        ...[...packages].map(relative),
      ],
      { cwd: root, encoding: "utf8", timeout: 5_000, maxBuffer: 8 * 1024 * 1024 },
    );
    if (sources.status !== 0 && sources.status !== 1) {
      problems.set(
        "deleted source imports",
        "cannot inspect imports with git grep; inspect git status before retrying",
      );
    }
    for (const importer of new Set(sources.status === 0 ? sources.stdout.split("\0") : [])) {
      if (!/\.[cm]?[jt]sx?$/.test(importer) || deleted.has(importer)) continue;
      let source;
      try {
        source = fs.readFileSync(path.join(root, importer), "utf8");
      } catch {
        inspect.add(importer);
        problems.set(importer, "present but broken (cannot read source)");
        continue;
      }
      // Skip comments and whole quoted strings before recognizing import declarations;
      // quoted code and commented-out imports must not turn intentional deletions into errors.
      const uncommented = source.replace(
        /"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`|\/\*[\s\S]*?\*\/|\/\/[^\r\n]*/g,
        (token) => (token.startsWith("//") || token.startsWith("/*") ? " " : token),
      );
      const imports =
        /(?:\b(?:import|export)\s+(?:[\w$*,\s]|\{[^}]*\})+?\s+from\s*|\bimport\s*|\b(?:import|require)\s*\(\s*)("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`/g;
      for (const match of uncommented.matchAll(imports)) {
        const specifier = match[1];
        if (!specifier || !/^['"]/.test(specifier)) continue;
        const name = specifier.slice(1, -1).split(/[?#]/)[0];
        let target;
        if (name.startsWith(".")) target = path.resolve(root, path.dirname(importer), name);
        else {
          const entry = [...manifests].find(
            ([, manifest]) =>
              typeof manifest.name === "string" &&
              (name === manifest.name || name.startsWith(`${manifest.name}/`)),
          );
          if (!entry) continue;
          const [dir, manifest] = entry;
          const subpath = name === manifest.name ? "." : `.${name.slice(manifest.name.length)}`;
          let exported = manifest.exports;
          let wildcard = "";
          if (
            exported &&
            typeof exported === "object" &&
            Object.keys(exported).some((key) => key.startsWith("."))
          ) {
            const key = Object.keys(exported)
              .sort((a, b) => b.length - a.length)
              .find((key) => {
                if (!key.includes("*")) return key === subpath;
                const [prefix, suffix] = key.split("*");
                if (!subpath.startsWith(prefix) || !subpath.endsWith(suffix)) return false;
                wildcard = subpath.slice(prefix.length, suffix ? -suffix.length : undefined);
                return true;
              });
            exported = key ? exported[key] : undefined;
          }
          while (exported && typeof exported === "object")
            exported = exported.import ?? exported.default ?? exported.types ?? exported.require;
          const file =
            typeof exported === "string"
              ? exported.replaceAll("*", wildcard)
              : manifest.exports
                ? undefined
                : subpath === "."
                  ? (manifest.main ?? "index.js")
                  : subpath;
          if (!file) continue;
          target = path.resolve(dir, file);
        }
        const stem = target.replace(/\.(?:[cm]?js|jsx)$/, "");
        const candidates = [
          target,
          ...[
            ".ts",
            ".tsx",
            ".mts",
            ".cts",
            ".js",
            ".jsx",
            "/index.ts",
            "/index.tsx",
            "/index.js",
          ].map((ext) => `${stem}${ext}`),
        ];
        const gone = candidates.map(relative).find((file) => deletedSources.has(file));
        // Most imports cannot name a deleted file. Avoid filesystem resolution for those.
        if (!gone || problems.get(gone)?.includes("; imported by ")) continue;
        if (candidates.some((file) => fs.existsSync(file) && fs.statSync(file).isFile())) continue;
        missing(path.join(root, gone));
        problems.set(gone, `${problems.get(gone)}; imported by ${importer}`);
      }
    }
  }

  if (problems.size === 0) return;
  // Shell-quote unusual paths; never execute this suggestion ourselves.
  const quote = (/** @type {string} */ name) =>
    /^[\w./-]+$/.test(name) ? name : `'${name.replaceAll("'", "'\\''")}'`;
  // Status is read-only. A path can be absent yet locally changed (including a staged
  // deletion); never infer that overwriting it is safe from absence alone.
  const status = inspect.size
    ? spawnSync("git", ["status", "--porcelain", "-z", "--", ...inspect], {
        cwd: root,
        encoding: "utf8",
        timeout: 5_000,
        maxBuffer: 4 * 1024 * 1024,
      })
    : undefined;
  const changed = new Map(
    status?.status === 0
      ? status.stdout.split("\0").map((line) => [line.slice(3), line.slice(0, 2)])
      : [],
  );
  const recoverable = [...inspect].filter((name) => {
    try {
      fs.lstatSync(path.join(root, name));
      return false;
    } catch (error) {
      return (
        error instanceof Error &&
        "code" in error &&
        error.code === "ENOENT" &&
        deleted.has(name) &&
        status?.status === 0 &&
        changed.get(name) === " D"
      );
    }
  });
  const shown = [...problems].slice(0, 8);
  const paths = [...inspect].slice(0, 8).map(quote).join(" ");
  return [
    "preview-app: cannot start preview; this checkout is incomplete or has invalid config.",
    ...shown.map(([file, reason]) => `  - ${file}: ${reason}.`),
    ...(problems.size > shown.length ? [`  ... ${problems.size - shown.length} more issues.`] : []),
    ...(paths
      ? [`Inspect checkout changes first: git status -- ${paths}; git diff -- ${paths}`]
      : []),
    ...([...inspect].some((name) => deleted.has(name))
      ? ["Deleted files may be intentional; check with whoever made the change first."]
      : []),
    ...(recoverable.length
      ? [
          `Only if deletion was unintended, restore: git restore -- ${recoverable.slice(0, 8).map(quote).join(" ")}`,
        ]
      : []),
    ...(install ? ["Install checkout dependencies: pnpm install"] : []),
    "Fix this checkout, then open preview again. No servers were started.",
  ].join("\n");
}
