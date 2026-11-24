// Which app a computer-use call names, and the apps no agent may use. An agent names an app as macOS shows it
// ("Safari"), by bundle id ("com.apple.Safari") or by its executable; LaunchServices (lsappinfo) says which running app
// that is, and an installed one that isn't running is found by its bundle in the usual folders. The blocked list is
// matched on all three, so no spelling of Terminal gets through.
import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export interface AppIdentity {
  /** As macOS shows it: "Safari", "System Settings". */
  readonly name: string;
  readonly bundleId?: string;
  /** The executable's file name, when known: what `--app` also accepts. */
  readonly executable?: string;
  /** Not an app: the clipboard, the menu bar's status items. Allowed like one. */
  readonly pseudo?: true;
}

export const CLIPBOARD: AppIdentity = { name: "Clipboard", pseudo: true };
export const MENU_BAR: AppIdentity = { name: "Menu Bar", pseudo: true };
export const DOCK: AppIdentity = { name: "Dock", bundleId: "com.apple.dock" };
export const NOTIFICATIONS: AppIdentity = { name: "Notification Center", bundleId: "com.apple.notificationcenterui" };
const PSEUDO = [CLIPBOARD, MENU_BAR];

const output = (file: string, args: ReadonlyArray<string>) =>
  new Promise<string>((resolve) => execFile(file, [...args], { timeout: 3_000, encoding: "utf8" }, (error, stdout) => resolve(error ? "" : stdout)));

/** A running app by name or bundle id (lsappinfo answers in some 30 ms). */
const running = async (query: string): Promise<AppIdentity | undefined> => {
  const out = await output("/usr/bin/lsappinfo", ["info", "-only", "bundleid", "-only", "name", "-only", "executablepath", query]);
  const name = /^"(.*)" ASN:/m.exec(out)?.[1];
  if (!name) return undefined;
  const bundleId = /bundleID="([^"]+)"/.exec(out)?.[1];
  const executable = /executable path="([^"]+)"/.exec(out)?.[1];
  return { name, ...(bundleId ? { bundleId } : {}), ...(executable ? { executable: path.basename(executable) } : {}) };
};

const APP_DIRS = ["/Applications", "/Applications/Utilities", "/System/Applications", "/System/Applications/Utilities", path.join(os.homedir(), "Applications"), "/System/Library/CoreServices"];

/** An installed app that isn't running, by its bundle's file name. */
const installed = async (query: string): Promise<AppIdentity | undefined> => {
  const want = `${query.toLowerCase().replace(/\.app$/, "")}.app`;
  for (const dir of APP_DIRS) {
    const entries = await fs.promises.readdir(dir).catch(() => [] as Array<string>);
    const hit = entries.find((entry) => entry.toLowerCase() === want);
    if (hit === undefined) continue;
    const plist = path.join(dir, hit, "Contents", "Info.plist");
    const bundleId = (await output("/usr/bin/plutil", ["-extract", "CFBundleIdentifier", "raw", plist])).trim();
    const executable = (await output("/usr/bin/plutil", ["-extract", "CFBundleExecutable", "raw", plist])).trim();
    return { name: hit.slice(0, -4), ...(bundleId ? { bundleId } : {}), ...(executable ? { executable } : {}) };
  }
  return undefined;
};

const BUNDLE_ID = /^[A-Za-z0-9-]+(\.[A-Za-z0-9-]+){2,}$/;

/** The app a name, bundle id or executable names: running first, then installed, else the name as given. */
export const resolveApp = async (query: string): Promise<AppIdentity> => {
  const trimmed = query.trim();
  const pseudo = PSEUDO.find((app) => app.name.toLowerCase() === trimmed.toLowerCase());
  if (pseudo) return pseudo;
  return (await running(trimmed)) ?? (await installed(trimmed)) ?? { name: trimmed.replace(/\.app$/i, ""), ...(BUNDLE_ID.test(trimmed) ? { bundleId: trimmed } : {}) };
};

/** Whether two identities are one app: the same bundle id when both have one, else the same name. */
export const sameApp = (a: { readonly name: string; readonly bundleId?: string | undefined }, b: { readonly name: string; readonly bundleId?: string | undefined }) =>
  a.bundleId !== undefined && b.bundleId !== undefined ? a.bundleId.toLowerCase() === b.bundleId.toLowerCase() : a.name.toLowerCase() === b.name.toLowerCase();

/** The apps no agent may use, whatever the person allowed, and why. Names, bundle ids and executables. */
const BLOCKED: ReadonlyArray<{ readonly why: string; readonly label: string; readonly apps: ReadonlyArray<readonly [string, string, ...Array<string>]> }> = [
  {
    why: "it runs commands outside the chat's approvals; use your own shell tool",
    label: "Terminals and script runners (Terminal, iTerm2, Warp, Ghostty, Script Editor, Automator, …)",
    apps: [
      ["Terminal", "com.apple.Terminal"],
      ["iTerm2", "com.googlecode.iterm2", "iTerm"],
      ["Warp", "dev.warp.Warp-Stable", "stable"],
      ["Ghostty", "com.mitchellh.ghostty", "ghostty"],
      ["kitty", "net.kovidgoyal.kitty"],
      ["Alacritty", "org.alacritty", "alacritty"],
      ["WezTerm", "com.github.wez.wezterm", "wezterm-gui"],
      ["Hyper", "co.zeit.hyper"],
      ["Tabby", "org.tabby"],
      ["Wave", "dev.commandline.waveterm"],
      ["Rio", "com.raphaelamorim.rio", "rio"],
      ["Script Editor", "com.apple.ScriptEditor2"],
      ["Automator", "com.apple.Automator"],
    ],
  },
  {
    why: "it holds the person's passwords",
    label: "Password managers (Passwords, Keychain Access, 1Password, Bitwarden, …)",
    apps: [
      ["Passwords", "com.apple.Passwords"],
      ["Keychain Access", "com.apple.keychainaccess"],
      ["1Password", "com.1password.1password"],
      ["1Password 7", "com.agilebits.onepassword7"],
      ["Bitwarden", "com.bitwarden.desktop"],
      ["Dashlane", "com.dashlane.dashlanephonefinal"],
      ["LastPass", "com.lastpass.LastPass"],
      ["KeePassXC", "org.keepassxc.keepassxc"],
      ["Enpass", "in.sinew.Enpass-Desktop"],
      ["Proton Pass", "me.proton.pass.electron"],
      ["NordPass", "com.nordsec.nordpass"],
    ],
  },
  { why: "it is Caveman Code itself, where the person approves what agents do", label: "Caveman Code", apps: [["Caveman Code", "so.caveman.code"]] },
  {
    why: "it asks for the person's password or approves macOS security prompts, which only the person may answer",
    label: "macOS password and security prompts",
    apps: [
      ["SecurityAgent", "com.apple.SecurityAgent"],
      ["loginwindow", "com.apple.loginwindow"],
      ["UserNotificationCenter", "com.apple.UserNotificationCenter"],
      ["universalAccessAuthWarn", "com.apple.accessibility.universalAccessAuthWarn"],
      ["CoreServicesUIAgent", "com.apple.CoreServicesUIAgent"],
      ["coreautha", "com.apple.LocalAuthentication.UIAgent"],
    ],
  },
];

const blockedBy = new Map<string, string>(BLOCKED.flatMap((group) => group.apps.flatMap((names) => names.map((name) => [name.toLowerCase(), group.why] as const))));

/** Why no agent may use `app`, or undefined when it may be asked for. */
export const blockedReason = (app: AppIdentity): string | undefined => {
  for (const name of [app.bundleId, app.name, app.executable]) {
    const why = name === undefined ? undefined : blockedBy.get(name.toLowerCase());
    if (why !== undefined) return why;
  }
  return undefined;
};

/** The blocked list as Settings shows it. */
export const BLOCKED_LABELS: ReadonlyArray<string> = BLOCKED.map((group) => group.label);
