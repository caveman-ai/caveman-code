// The OS the page runs on, for key glyphs, the words for the computer and its
// file manager, the window's title band and paths. The page runs in the
// desktop app and in an ordinary browser (the runtime serves it at / for
// `caveman code`), so it reads the browser's own report, never the desktop
// preload: navigator.userAgentData.platform where Chromium has it, else
// navigator.platform, else the user agent.

export type Os = "mac" | "windows" | "linux" | "other";

interface NavigatorLike {
  readonly userAgentData?: { readonly platform?: string } | undefined;
  readonly platform?: string;
  readonly userAgent?: string;
}

export function osOf(nav: NavigatorLike | undefined): Os {
  if (!nav) return "other";
  const hint = nav.userAgentData?.platform ?? "";
  const platform = nav.platform ?? "";
  // The test the shortcuts always made (chrome.tsx): a Mac, and the iPad and iPhone that type with ⌘.
  if (/Mac|iPhone|iPad/.test(platform) || hint === "macOS") return "mac";
  if (hint === "Windows" || /^Win/.test(platform) || /Windows NT/.test(nav.userAgent ?? "")) return "windows";
  if (hint === "Linux" || /Linux/.test(platform)) return "linux";
  return "other";
}

export const OS: Os = osOf(typeof navigator === "undefined" ? undefined : (navigator as NavigatorLike));
export const IS_MAC = OS === "mac";
export const IS_WINDOWS = OS === "windows";

/** What the computer is called: "Mac", "PC" (Windows' own word, as in This PC), else "computer". */
export const computerNoun = (os: Os): string => (os === "mac" ? "Mac" : os === "windows" ? "PC" : "computer");
/** Showing a file or folder, selected, in the system's file manager. */
export const revealLabelFor = (os: Os): string => (os === "mac" ? "Reveal in Finder" : os === "windows" ? "Show in File Explorer" : "Show in file manager");

/** "Mac", "PC" or "computer": "your Mac", "the PC". */
export const COMPUTER = computerNoun(OS);
/** The computer the page runs on, as a name: "This Mac", "This PC", "This computer". */
export const THIS_COMPUTER = `This ${COMPUTER}`;
/** The same inside a sentence: "this Mac", "this PC", "this computer". */
export const thisComputer = `this ${COMPUTER}`;
/** "Reveal in Finder", "Show in File Explorer", "Show in file manager". */
export const REVEAL_LABEL = revealLabelFor(OS);
