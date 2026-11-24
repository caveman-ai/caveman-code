// The right-click menu. Electron shows none of its own, so without this a
// right-click in the composer, a transcript or the side panel's browser did
// nothing: no Cut, Copy or Paste, no spelling suggestions. Ported from T3
// Code's window/DesktopWindow.ts installContextMenu (MIT, 13aa882c22), with
// Back, Forward, Reload and Inspect Element added for a page in the side
// panel's browser (the dev server an agent is building, as in Chrome).
// Electron-free, so it tests without Electron; main.ts pops the menu. A page
// that draws its own menu (the sidebar's, a file tree's) calls preventDefault
// on contextmenu, and Chromium then never asks for this one.

/** The parts of Electron's ContextMenuParams read here. */
export interface ContextMenuInput {
  readonly x: number;
  readonly y: number;
  readonly isEditable: boolean;
  readonly selectionText: string;
  readonly linkURL: string;
  readonly mediaType: string;
  readonly misspelledWord: string;
  readonly dictionarySuggestions: ReadonlyArray<string>;
  readonly editFlags: { readonly canCut: boolean; readonly canCopy: boolean; readonly canPaste: boolean; readonly canSelectAll: boolean };
}

export type EditCommand = "cut" | "copy" | "paste" | "pasteAndMatchStyle" | "selectAll";

/** What the menu's items do, on the web contents that was right-clicked. */
export interface ContextMenuActions {
  edit(command: EditCommand): void;
  replaceMisspelling(word: string): void;
  learnSpelling(word: string): void;
  copyText(text: string): void;
  copyImageAt(x: number, y: number): void;
  openExternal(url: string): void;
}

/** A page in the side panel's browser: it also gets Back, Forward, Reload and Inspect Element. */
export interface GuestNavigation {
  readonly canGoBack: boolean;
  readonly canGoForward: boolean;
  back(): void;
  forward(): void;
  reload(): void;
  /** DevTools on the page, at the element under the pointer. */
  inspect(x: number, y: number): void;
}

/** Electron's MenuItemConstructorOptions, the subset used here. */
export interface ContextMenuItem {
  readonly label?: string;
  readonly type?: "separator";
  readonly enabled?: boolean;
  readonly accelerator?: string;
  readonly registerAccelerator?: boolean;
  readonly click?: () => void;
}

/** Only links a browser can open leave the app. */
export const isOpenableLink = (url: string): boolean => /^(https?|mailto):/i.test(url);

const item = (label: string, click: () => void, extra: Partial<ContextMenuItem> = {}): ContextMenuItem => ({ label, click, ...extra });
// Shown, never registered: the Edit menu owns the chords.
const chord = (accelerator: string) => ({ accelerator, registerAccelerator: false });

/** The items for one right-click, in groups split by separators. Empty: show no menu. */
export function contextMenuTemplate(input: ContextMenuInput, actions: ContextMenuActions, guest?: GuestNavigation): ContextMenuItem[] {
  const groups: ContextMenuItem[][] = [];
  const word = input.misspelledWord;
  if (input.isEditable && word) {
    const suggestions = input.dictionarySuggestions.slice(0, 5).map((s) => item(s, () => actions.replaceMisspelling(s)));
    groups.push([
      ...(suggestions.length ? suggestions : [{ label: "No Guesses Found", enabled: false }]),
      item("Learn Spelling", () => actions.learnSpelling(word)),
    ]);
  }
  if (isOpenableLink(input.linkURL)) {
    const url = input.linkURL;
    groups.push([
      // The app's own links already open in the browser on a click; a guest's open in the panel.
      ...(guest ? [item("Open Link in Browser", () => actions.openExternal(url))] : []),
      item(url.toLowerCase().startsWith("mailto:") ? "Copy Email Address" : "Copy Link", () => actions.copyText(url.replace(/^mailto:/i, ""))),
    ]);
  }
  if (input.mediaType === "image") groups.push([item("Copy Image", () => actions.copyImageAt(input.x, input.y))]);
  const { canCut, canCopy, canPaste, canSelectAll } = input.editFlags;
  if (input.isEditable) {
    groups.push([
      item("Cut", () => actions.edit("cut"), { enabled: canCut, ...chord("CmdOrCtrl+X") }),
      item("Copy", () => actions.edit("copy"), { enabled: canCopy, ...chord("CmdOrCtrl+C") }),
      item("Paste", () => actions.edit("paste"), { enabled: canPaste, ...chord("CmdOrCtrl+V") }),
      item("Paste and Match Style", () => actions.edit("pasteAndMatchStyle"), { enabled: canPaste, ...chord("CmdOrCtrl+Shift+Alt+V") }),
      item("Select All", () => actions.edit("selectAll"), { enabled: canSelectAll, ...chord("CmdOrCtrl+A") }),
    ]);
  } else if (input.selectionText.trim()) {
    groups.push([item("Copy", () => actions.edit("copy"), { enabled: canCopy, ...chord("CmdOrCtrl+C") })]);
  }
  // A right-click on a guest page's background, as in a browser.
  if (guest && groups.length === 0) {
    groups.push([
      item("Back", () => guest.back(), { enabled: guest.canGoBack }),
      item("Forward", () => guest.forward(), { enabled: guest.canGoForward }),
      item("Reload", () => guest.reload()),
    ]);
  }
  // Last on every right-click in a guest page, as in a browser.
  if (guest) groups.push([item("Inspect Element", () => guest.inspect(input.x, input.y))]);
  return groups.flatMap((group, i) => (i === 0 ? group : [{ type: "separator" as const }, ...group]));
}
