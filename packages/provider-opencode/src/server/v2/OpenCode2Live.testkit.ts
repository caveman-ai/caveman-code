// @effect-diagnostics nodeBuiltinImport:off
import { execFileSync } from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { classifyOpenCodeCliVersion } from "../versionProbe.ts";

/**
 * The version the installed `opencode` reports, read the way the provider's own probe reads it,
 * in a throwaway home. The live checks compare the server's answer to this, never to the release
 * T3 recorded, so they pass on whichever 2.x is installed and still catch a server that lies.
 */
export function installedOpenCodeVersion(binaryPath: string): string {
  const home = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "opencode2-version-"));
  try {
    const output = execFileSync(binaryPath, ["--version"], {
      encoding: "utf8",
      env: { PATH: process.env.PATH, HOME: home, XDG_CONFIG_HOME: home, XDG_DATA_HOME: home },
      timeout: 15_000,
    });
    const probed = classifyOpenCodeCliVersion(output);
    if (probed?.generation !== "v2") {
      throw new Error(`OPENCODE2_BIN is not an OpenCode 2.x binary: ${output.trim()}`);
    }
    return probed.version;
  } finally {
    NodeFS.rmSync(home, { recursive: true, force: true });
  }
}
