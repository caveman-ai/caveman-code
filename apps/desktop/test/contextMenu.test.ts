import { describe, expect, it, vi } from "vitest";
import { contextMenuTemplate, isOpenableLink, type ContextMenuActions, type ContextMenuInput } from "../src/contextMenu.ts";

const base: ContextMenuInput = {
  x: 10,
  y: 20,
  isEditable: false,
  selectionText: "",
  linkURL: "",
  mediaType: "none",
  misspelledWord: "",
  dictionarySuggestions: [],
  editFlags: { canCut: false, canCopy: false, canPaste: false, canSelectAll: false },
};
const actions = (): ContextMenuActions => ({
  edit: vi.fn(),
  replaceMisspelling: vi.fn(),
  learnSpelling: vi.fn(),
  copyText: vi.fn(),
  copyImageAt: vi.fn(),
  openExternal: vi.fn(),
});
const labels = (items: ReturnType<typeof contextMenuTemplate>) => items.map((i) => (i.type === "separator" ? "---" : i.label));

describe("context menu", () => {
  it("offers Cut, Copy, Paste and Select All in a text box, enabled as Chromium says", () => {
    const a = actions();
    const items = contextMenuTemplate({ ...base, isEditable: true, editFlags: { canCut: false, canCopy: false, canPaste: true, canSelectAll: true } }, a);
    expect(labels(items)).toEqual(["Cut", "Copy", "Paste", "Paste and Match Style", "Select All"]);
    expect(items.map((i) => i.enabled)).toEqual([false, false, true, true, true]);
    // Shown beside the item, never registered over the Edit menu's.
    expect(items.every((i) => i.registerAccelerator === false)).toBe(true);
    items.find((i) => i.label === "Paste")!.click!();
    expect(a.edit).toHaveBeenCalledWith("paste");
  });

  it("puts spelling suggestions first for a misspelled word, at most five", () => {
    const a = actions();
    const items = contextMenuTemplate(
      { ...base, isEditable: true, misspelledWord: "teh", dictionarySuggestions: ["the", "ten", "tea", "tee", "toe", "tie"] },
      a,
    );
    expect(labels(items).slice(0, 7)).toEqual(["the", "ten", "tea", "tee", "toe", "Learn Spelling", "---"]);
    items[0]!.click!();
    expect(a.replaceMisspelling).toHaveBeenCalledWith("the");
    items[5]!.click!();
    expect(a.learnSpelling).toHaveBeenCalledWith("teh");
    expect(labels(contextMenuTemplate({ ...base, isEditable: true, misspelledWord: "qzxv" }, a))[0]).toBe("No Guesses Found");
  });

  it("copies a selection outside a text box, and shows nothing on the app's bare background", () => {
    expect(labels(contextMenuTemplate({ ...base, selectionText: "some words", editFlags: { ...base.editFlags, canCopy: true } }, actions()))).toEqual(["Copy"]);
    expect(contextMenuTemplate(base, actions())).toEqual([]);
    expect(contextMenuTemplate({ ...base, selectionText: "  \n" }, actions())).toEqual([]);
  });

  it("copies web and email links, never another scheme", () => {
    const a = actions();
    const link = contextMenuTemplate({ ...base, linkURL: "https://caveman.so/x" }, a);
    expect(labels(link)).toEqual(["Copy Link"]);
    link[0]!.click!();
    expect(a.copyText).toHaveBeenCalledWith("https://caveman.so/x");
    const mail = contextMenuTemplate({ ...base, linkURL: "mailto:hi@caveman.so" }, a);
    expect(labels(mail)).toEqual(["Copy Email Address"]);
    mail[0]!.click!();
    expect(a.copyText).toHaveBeenLastCalledWith("hi@caveman.so");
    expect(contextMenuTemplate({ ...base, linkURL: "javascript:alert(1)" }, a)).toEqual([]);
    expect(contextMenuTemplate({ ...base, linkURL: "file:///etc/passwd" }, a)).toEqual([]);
    expect(isOpenableLink("caveman-code://app/")).toBe(false);
  });

  it("copies the image under the pointer", () => {
    const a = actions();
    const items = contextMenuTemplate({ ...base, mediaType: "image" }, a);
    expect(labels(items)).toEqual(["Copy Image"]);
    items[0]!.click!();
    expect(a.copyImageAt).toHaveBeenCalledWith(10, 20);
  });

  it("gives a page in the side panel's browser Back, Forward and Reload, and a way out for its links", () => {
    const a = actions();
    const guest = { canGoBack: true, canGoForward: false, back: vi.fn(), forward: vi.fn(), reload: vi.fn(), inspect: vi.fn() };
    const items = contextMenuTemplate(base, a, guest);
    expect(labels(items)).toEqual(["Back", "Forward", "Reload", "---", "Inspect Element"]);
    expect(items.map((i) => i.enabled)).toEqual([true, false, undefined, undefined, undefined]);
    items[0]!.click!();
    expect(guest.back).toHaveBeenCalled();
    const link = contextMenuTemplate({ ...base, linkURL: "https://example.com/" }, a, guest);
    expect(labels(link)).toEqual(["Open Link in Browser", "Copy Link", "---", "Inspect Element"]);
    link[0]!.click!();
    expect(a.openExternal).toHaveBeenCalledWith("https://example.com/");
  });

  it("ends every right-click in a browser page with Inspect Element at the pointer, and never offers it in the app", () => {
    const guest = { canGoBack: false, canGoForward: false, back: vi.fn(), forward: vi.fn(), reload: vi.fn(), inspect: vi.fn() };
    const text = { ...base, x: 41, y: 77, isEditable: true, editFlags: { canCut: true, canCopy: true, canPaste: true, canSelectAll: true } };
    const items = contextMenuTemplate(text, actions(), guest);
    expect(labels(items).slice(-2)).toEqual(["---", "Inspect Element"]);
    items.at(-1)!.click!();
    expect(guest.inspect).toHaveBeenCalledWith(41, 77);
    expect(labels(contextMenuTemplate(text, actions()))).not.toContain("Inspect Element");
    expect(contextMenuTemplate(base, actions())).toEqual([]);
  });
});
