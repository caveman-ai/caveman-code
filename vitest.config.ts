// ), vite.config.ts (test block) @ ab3a3cd1.
import { defineConfig } from "vitest/config";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

// Tests never write into the developer's real home or user config dirs.
const scratchHome = NodeFS.mkdtempSync(
  NodePath.join(NodeFS.realpathSync(NodeOS.tmpdir()), "caveman-test-home-"),
);

export default defineConfig({
  test: {
    environment: "node",
    exclude: ["**/node_modules/**", "**/dist/**", "**/.{idea,git,cache,output,temp}/**"],
    hookTimeout: 60_000,
    testTimeout: 60_000,
    env: {
      HOME: scratchHome,
      USERPROFILE: scratchHome,
      XDG_CONFIG_HOME: NodePath.join(scratchHome, ".config"),
      XDG_DATA_HOME: NodePath.join(scratchHome, ".local", "share"),
      XDG_CACHE_HOME: NodePath.join(scratchHome, ".cache"),
      XDG_STATE_HOME: NodePath.join(scratchHome, ".local", "state"),
      APPDATA: NodePath.join(scratchHome, "AppData", "Roaming"),
      LOCALAPPDATA: NodePath.join(scratchHome, "AppData", "Local"),
      // Tests never fetch models.dev; a test that needs its facts sets them (provider-caveman modelsDev.ts).
      CAVEMAN_MODELS_DEV_URL: "off",
    },
    setupFiles: [
      NodeURL.fileURLToPath(
        new URL("./packages/shared/src/testing/longTempDir.ts", import.meta.url),
      ),
      NodeURL.fileURLToPath(
        new URL("./packages/shared/src/testing/userConfigIsolation.ts", import.meta.url),
      ),
      NodeURL.fileURLToPath(new URL("./packages/shared/src/testing/exeSearch.ts", import.meta.url)),
    ],
  },
});
