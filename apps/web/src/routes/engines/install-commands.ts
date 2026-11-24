// How to install the two CLIs Claude Agent and Codex run on, for the computer the page is on. The app installs
// nothing itself (the runtime's providerInstallation.ts): it shows the command to copy and checks again.

import type { Os } from "../../lib/platform.ts";

export type InstallCommand = {
  readonly command: string;
  /** What the command needs, said under it. */
  readonly needs?: string;
};

const NPM = "Needs Node.js.";

/**
 * Claude Agent runs the official `claude`. Anthropic's own installer is the recommended way (it updates itself):
 * macOS, Linux and WSL run the curl line, Windows PowerShell the irm line; anywhere else, npm. The runtime's own
 * not-found message names the same commands (packages/runtime ClaudeProvider.ts claudeInstallLine).
 * Source: https://docs.claude.com/en/docs/claude-code/setup (redirects to https://code.claude.com/docs/en/setup,
 * "Install Claude Code", checked 21 Nov 2026).
 */
export function claudeInstall(os: Os): InstallCommand {
  if (os === "mac" || os === "linux")
    return { command: "curl -fsSL https://claude.ai/install.sh | bash" };
  if (os === "windows")
    return { command: "irm https://claude.ai/install.ps1 | iex", needs: "Run it in PowerShell." };
  return { command: "npm install -g @anthropic-ai/claude-code@latest", needs: NPM };
}

/** Codex: the runtime's own message names npm (CodexProvider.ts), on every computer. */
export function codexInstall(_os: Os): InstallCommand {
  return { command: "npm install -g @openai/codex", needs: NPM };
}

export const installFor = (engine: "claude-agent" | "codex", os: Os): InstallCommand =>
  engine === "claude-agent" ? claudeInstall(os) : codexInstall(os);
