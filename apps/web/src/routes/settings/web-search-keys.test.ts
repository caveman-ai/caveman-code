import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { expect, test } from "vitest";

import { RuntimeContext, type RuntimeContextValue } from "../../state/runtime.tsx";
import { firecrawlLine, WEB_KEYS_ELSEWHERE, WEB_PROVIDERS, WebKeyRow, WebSearchCard } from "./WebSearchKeys.tsx";

// Settings > Models & keys > Web search, rendered as the person sees it.
const runtime = { client: null, settings: null, engines: [], workspaces: [], refresh: async () => undefined } as unknown as RuntimeContextValue;
const row = (status: Parameters<typeof WebKeyRow>[0]["status"], provider = WEB_PROVIDERS[0]!) =>
  renderToStaticMarkup(createElement(RuntimeContext.Provider, { value: runtime }, createElement(WebKeyRow, { provider, status, onChange: () => undefined, onError: () => undefined })));

test("a kept key its provider refused at search or read time says so", () => {
  expect(row({ id: "brave", configured: true, hint: "...abcd", refused: true })).toContain("Brave Search refused this key at its last search. Remove it and add a new one.");
  expect(row({ id: "brave", configured: true, hint: "...abcd" })).not.toContain("refused this key");
  const firecrawl = WEB_PROVIDERS.find((p) => p.id === "firecrawl")!;
  expect(row({ id: "firecrawl", configured: true, hint: "...abcd", refused: true }, firecrawl)).toContain("Firecrawl refused this key at its last read. Remove it and add a new one.");
});

const card = (props: Partial<Parameters<typeof WebSearchCard>[0]>) =>
  renderToStaticMarkup(
    createElement(
      MemoryRouter,
      null,
      createElement(RuntimeContext.Provider, { value: runtime }, createElement(WebSearchCard, { keys: null, loadError: null, error: null, onChange: () => undefined, onError: () => undefined, ...props })),
    ),
  );
const none = { providers: WEB_PROVIDERS.map((p) => ({ id: p.id, configured: false })), credits: true };

test("each Get a key link names its provider, and a note is announced when it appears", () => {
  const html = card({ keys: none });
  for (const p of WEB_PROVIDERS) expect(html).toContain(`aria-label="Get a ${p.label} key (opens in a new tab)"`);
  expect(html.match(/role="status" aria-live="polite"/g)).toHaveLength(WEB_PROVIDERS.length);
});

test("says so when the runtime could not answer, instead of showing nothing", () => {
  expect(card({ loadError: "The runtime is not answering." })).toContain("Could not read the web search settings: The runtime is not answering.");
  expect(card({})).toBe("");
});

test("on a Cloud computer that keeps nothing of its person's the card has no key field: it says where a key is added, and a key kept from before can only be removed", () => {
  expect(WEB_KEYS_ELSEWHERE).toBe("Web search in Cloud runs on Caveman credits. Add your own key on your Mac (Settings > Models & keys).");
  const there = card({ keys: none, outside: true });
  expect(there.replaceAll("&gt;", ">").replaceAll("&amp;", "&")).toContain(WEB_KEYS_ELSEWHERE);
  expect(there).toContain("Caveman credits");
  expect(there).not.toContain("stored encrypted on this computer");
  // The runtime refuses web.keys.set there: no field, no Add, no link to get a key.
  expect(there).not.toContain("<input");
  expect(there).not.toContain("<form");
  expect(there).not.toContain("Get a key");
  for (const p of WEB_PROVIDERS) expect(there).not.toContain(p.label);

  const kept = card({ keys: { ...none, providers: [{ id: "brave", configured: true, hint: "...abcd" }, ...none.providers.slice(1)] }, outside: true });
  expect(kept).toContain("...abcd");
  expect(kept).toContain('aria-label="Remove the Brave Search key"');
  expect(kept).not.toContain("<input");
  expect(kept).not.toContain("Perplexity");

  // A Mac keeps every field.
  const mac = card({ keys: none });
  expect(mac).not.toContain(WEB_KEYS_ELSEWHERE);
  expect(mac.match(/<input/g)).toHaveLength(WEB_PROVIDERS.length);
});

test("a company's own Cloud that sells no credits shows no credits row and says searches run on your own key", () => {
  const offered = card({ keys: none });
  expect(offered).toContain("Caveman credits");
  expect(offered).toContain("Search runs on Caveman credits, at cost");
  const own = card({ keys: { ...none, credits: false }, credits: false });
  expect(own).not.toContain("Caveman credits");
  expect(own).toContain("on a key of your own");
});

test("a Firecrawl key alone leaves search on credits: it reads pages, it never searches", () => {
  const firecrawlOnly = { ...none, providers: none.providers.map((p) => (p.id === "firecrawl" ? { ...p, configured: true, hint: "...abcd" } : p)) };
  expect(card({ keys: firecrawlOnly })).toContain("Searches run on your credits, at cost.");
  const braveToo = { ...none, providers: firecrawlOnly.providers.map((p) => (p.id === "brave" ? { ...p, configured: true, hint: "...wxyz" } : p)) };
  expect(card({ keys: braveToo })).toContain("Used when none of your keys answers.");
});

test("the Firecrawl row says whether Firecrawl Local reads pages here, and how to install it when it doesn't", () => {
  const html = (firecrawl_local: boolean | undefined) => card({ keys: { ...none, ...(firecrawl_local === undefined ? {} : { firecrawl_local }) } }).replaceAll("&#x27;", "'");
  expect(html(true)).toContain(firecrawlLine(true));
  expect(firecrawlLine(true)).toContain("Firecrawl Local reads pages on this computer");
  expect(html(false)).toContain("cargo install firecrawl-local");
  // An older runtime that does not say: the line about the key.
  expect(html(undefined)).toContain(WEB_PROVIDERS.find((p) => p.id === "firecrawl")!.line);
});
