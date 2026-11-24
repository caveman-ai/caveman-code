// node --test scripts/runtime-affected.test.ts (CI's `changes` job runs it before it trusts the script's answer).
import * as assert from "node:assert/strict";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { test } from "node:test";

import { reason, runtimeReach } from "./runtime-affected.ts";

function fixture(files: Record<string, string>): string {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "runtime-affected-"));
  for (const [path, text] of Object.entries(files)) {
    NodeFS.mkdirSync(NodePath.dirname(NodePath.join(dir, path)), { recursive: true });
    NodeFS.writeFileSync(NodePath.join(dir, path), text);
  }
  return dir;
}

const repo = fixture({
  // A static import, a template import of a folder, and a JSON read, as the runtime's tests have them.
  "packages/runtime/src/a.test.ts": `import { onLidClose } from "../../../apps/desktop/src/lid.ts";`,
  "packages/runtime/src/b.test.ts":
    "const web = (p) => import(new URL(`../../../apps/web/src/state/${p}`, import.meta.url).href);",
  "packages/runtime/src/c.test.ts": `readFileSync(new URL("../../../apps/web/src/routes/offer.fixture.json", import.meta.url));`,
  "apps/desktop/src/lid.ts": `import { power } from "./power";`,
  "apps/desktop/src/power.ts": "export const power = 1;",
  "apps/desktop/src/main.ts": `import { onLidClose } from "./lid.ts";`,
  "apps/web/src/state/store.ts": `import { look } from "../wallpaper/look.ts"; import { Button } from "@caveman-app/ui";`,
  "apps/web/src/state/store.test.ts": `import { app } from "../../test/app.tsx";`,
  "apps/web/src/wallpaper/look.ts": "export const look = 1;",
  "apps/web/src/wallpaper/Wallpaper.tsx": `import { look } from "./look.ts";`,
  "apps/web/src/routes/offer.fixture.json": "{}",
  "apps/web/test/app.tsx": "export const app = 1;",
});

test("reach follows static, template and file paths, then their relative imports", () => {
  const reach = runtimeReach(repo);
  assert.deepEqual([...reach.files].sort(), [
    "apps/desktop/src/lid.ts",
    "apps/desktop/src/power.ts",
    "apps/web/src/routes/offer.fixture.json",
    "apps/web/src/state/store.ts",
    "apps/web/src/wallpaper/look.ts",
  ]);
  assert.equal(reach.ui, true);
});

test("app code outside the reach, docs and Markdown skip the shards; everything else runs them", () => {
  const reach = runtimeReach(repo);
  assert.equal(reason("apps/desktop/src/main.ts", reach), undefined);
  assert.equal(reason("apps/web/src/wallpaper/Wallpaper.tsx", reach), undefined);
  assert.equal(reason("apps/web/src/state/store.test.ts", reach), undefined);
  assert.equal(reason("docs/", reach), undefined);
  assert.equal(reason("AGENTS.md", reach), undefined);
  assert.ok(reason("apps/web/src/wallpaper/look.ts", reach));
  assert.ok(reason("apps/desktop/src/power.ts", reach));
  assert.ok(reason("packages/ui/src/button.tsx", reach));
  assert.ok(reason("packages/runtime/src/server.ts", reach));
  assert.ok(reason("packages/runtime/prompts/chief.md", reach));
  assert.ok(reason("apps/web/package.json", reach));
  assert.ok(reason("pnpm-lock.yaml", reach));
  assert.ok(reason(".github/workflows/ci.yml", reach));
  assert.equal(reason("packages/ui/src/button.tsx", { files: reach.files, ui: false }), undefined);
});
