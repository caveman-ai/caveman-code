// Share to Caveman (system/share.ts): what came in one shape, the words a box gets, the link the extension opens the
// app with, and which files are the app's to delete.
import type { SharePayload } from "expo-sharing";
import { describe, expect, it, vi } from "vitest";

vi.mock("react-native", () => ({
  AppState: { addEventListener: () => ({ remove: () => {} }) },
  Image: { getSize: () => Promise.reject(new Error("no images in tests")) },
  Linking: { addEventListener: () => ({ remove: () => {} }) },
  Platform: { OS: "ios" },
}));

const { dropShare, isShareLink, linkOf, receive, sharedNow, takeShare, underOwnedRoots, wordsAndLink, wordsOf } = await import("./share");

const text = (value: string): SharePayload => ({ shareType: "text", value, mimeType: "text/plain" });
const url = (value: string): SharePayload => ({ shareType: "url", value, mimeType: "text/plain" });

describe("linkOf", () => {
  it("takes the host without www", () => {
    expect(linkOf("https://www.github.com/caveman-ai/caveman-code/issues/412")).toEqual({ href: "https://www.github.com/caveman-ai/caveman-code/issues/412", host: "github.com" });
    expect(linkOf("  http://user:pw@Example.COM:8080/x ")).toEqual({ href: "http://user:pw@Example.COM:8080/x", host: "example.com" });
  });
  it("is nothing for words or other schemes", () => {
    expect(linkOf("read https://example.com")).toBeUndefined();
    expect(linkOf("file:///private/var/x.png")).toBeUndefined();
    expect(linkOf("")).toBeUndefined();
  });
});

describe("wordsAndLink", () => {
  it("keeps a link and the words that came with it", () => {
    expect(wordsAndLink([text("Look at this"), url("https://github.com/a/b/issues/1")])).toEqual({ text: "Look at this", url: { href: "https://github.com/a/b/issues/1", host: "github.com" } });
  });
  it("joins texts once each, a blank line between", () => {
    expect(wordsAndLink([text(" one "), text("two"), text("one")])).toEqual({ text: "one\n\ntwo" });
  });
  it("reads a text that is only an address as the link", () => {
    expect(wordsAndLink([text("https://example.com/page")])).toEqual({ url: { href: "https://example.com/page", host: "example.com" } });
    // A link already came: the same address as text is not said twice.
    expect(wordsAndLink([url("https://example.com/page"), text("https://example.com/page")])).toEqual({ url: { href: "https://example.com/page", host: "example.com" } });
  });
  it("leaves pictures out", () => {
    expect(wordsAndLink([{ shareType: "image", value: "file:///x.png", mimeType: "image/png" }])).toEqual({});
  });
});

describe("wordsOf", () => {
  it("is the text, then the link on its own line", () => {
    expect(wordsOf({ text: "Fix this", url: { href: "https://x.dev/1", host: "x.dev" } })).toBe("Fix this\nhttps://x.dev/1");
    expect(wordsOf({ url: { href: "https://x.dev/1", host: "x.dev" } })).toBe("https://x.dev/1");
    expect(wordsOf({ text: "Fix this" })).toBe("Fix this");
    expect(wordsOf({})).toBe("");
  });
  it("doesn't add a link the text already holds", () => {
    expect(wordsOf({ text: "See https://x.dev/1 please", url: { href: "https://x.dev/1", host: "x.dev" } })).toBe("See https://x.dev/1 please");
  });
});

describe("isShareLink", () => {
  it("is the extension's link, whatever the scheme", () => {
    expect(isShareLink("caveman://expo-sharing")).toBe(true);
    expect(isShareLink("caveman://expo-sharing?x=1")).toBe(true);
    expect(isShareLink("exp+caveman://expo-sharing/")).toBe(true);
  });
  it("is not a screen's link", () => {
    expect(isShareLink("caveman://chat/abc")).toBe(false);
    expect(isShareLink("caveman://expo-sharing-else")).toBe(false);
  });
});

describe("underOwnedRoots", () => {
  const group = "file:///private/var/mobile/Containers/Shared/AppGroup/ABC/";
  it("is a file strictly inside a root, /private or not", () => {
    expect(underOwnedRoots("file:///var/mobile/Containers/Shared/AppGroup/ABC/photo.jpg", [group])).toBe(true);
    expect(underOwnedRoots("file:///private/var/mobile/Containers/Shared/AppGroup/ABC/a%20b.jpg", [group])).toBe(true);
  });
  it("is never the root itself, a climb out, another app's file or not a file", () => {
    expect(underOwnedRoots(group, [group])).toBe(false);
    expect(underOwnedRoots("file:///var/mobile/Containers/Shared/AppGroup/ABC/..%2F..%2Fother.jpg", [group])).toBe(false);
    expect(underOwnedRoots("file:///var/mobile/Containers/Data/Application/XYZ/Documents/mine.pdf", [group])).toBe(false);
    expect(underOwnedRoots("content://media/external/images/1", [group])).toBe(false);
  });
});

describe("the waiting share", () => {
  it("is taken once, and dropped", () => {
    receive({ id: "s1", text: "hi", images: [] });
    expect(sharedNow()?.id).toBe("s1");
    expect(takeShare()?.id).toBe("s1");
    expect(takeShare()).toBeNull();
    receive({ id: "s2", images: [] });
    dropShare();
    expect(sharedNow()).toBeNull();
  });
});
