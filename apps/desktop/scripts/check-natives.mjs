// Loads the runtime's lazily loaded natives from a built runtime, on the Node that runs it, as the runtime does:
// onnxruntime-node (chat search's embeddings, src/chatSearch) and fff (file search, src/workspace/WorkspaceSearchIndex),
// whose library ffi-rs opens. Neither loads at the runtime's start, so a missing dependency (a clean Windows has no
// Visual C++ runtime) shows only when someone searches. scripts/package.mjs runs it on every build; windows.yml also
// runs it in a Windows Server Core container, which has no Visual C++ runtime installed.
//
//   <runtime>/node[.exe] apps/desktop/scripts/check-natives.mjs <runtime dir>
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const runtimeDir = process.argv[2];
if (!runtimeDir) throw new Error("usage: check-natives.mjs <runtime dir>");
const require = createRequire(join(runtimeDir, "bin.mjs"));

// Its binding (and onnxruntime.dll beside it) loads when the module does.
require("onnxruntime-node");
console.log("onnxruntime-node loaded");

const { FileFinder } = await import(pathToFileURL(require.resolve("@ff-labs/fff-node")).href);
const empty = mkdtempSync(join(tmpdir(), "caveman-natives-"));
const made = FileFinder.create({ basePath: empty, disableMmapCache: true, disableContentIndexing: true, aiMode: false });
if (!made.ok) throw new Error(`fff: ${made.error}`);
made.value.destroy?.();
rmSync(empty, { recursive: true, force: true });
console.log(`natives ok: onnxruntime-node and fff on node ${process.version}`);
process.exit(0);
