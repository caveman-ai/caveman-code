// A web row in the chat (docs/ "In the transcript"): a search's line opens to its sources and a
// page read's to its page, each a link out by title and site, never the page's text.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, test, vi } from "vitest";
import type { ToolItem } from "../../state/transcript-model.ts";
import { WebSources, WorkRun } from "./WorkRun.tsx";

// WorkRun names threads as their pills do; the window's pane store is browser-only and unrelated here.
vi.mock("../../panes/store.ts", () => ({ panes: {} }));

const at = "2026-10-18T08:00:00.000Z";
const web = (id: string, page: boolean, verb: string, subject: string, sources: ToolItem["sources"]): ToolItem => ({
  kind: "tool",
  id,
  verb,
  subject,
  parts: [{ action: page ? "web" : "web_search", subject }],
  command: null,
  status: "done",
  startedAt: at,
  finishedAt: "2026-10-18T08:00:01.400Z",
  added: null,
  removed: null,
  output: "",
  name: page ? "web_fetch" : "web_search",
  input: {},
  result: null,
  icon: "web",
  ...(sources ? { sources } : {}),
});

test("each source links out by its title and site, opening in the browser as the chat's links do", () => {
  const html = renderToStaticMarkup(
    createElement(WebSources, {
      sources: [
        { title: "Tickets - FIFA World Cup 2026™", url: "https://www.fifa.com/en/tickets" },
        { title: null, url: "https://example.com/docs/" },
        // The model never keeps one, and the list would not open it either.
        { title: "x", url: "javascript:alert(1)" },
      ],
    }),
  );
  expect(html).toContain('aria-label="Sources"');
  expect(html.match(/<a /g)).toHaveLength(2);
  expect(html).toContain('href="https://www.fifa.com/en/tickets" target="_blank" rel="noreferrer" title="https://www.fifa.com/en/tickets"');
  expect(html).toContain(">Tickets - FIFA World Cup 2026™</span>");
  expect(html).toContain(">fifa.com</span>");
  // A page with no title reads as its address, without the scheme, and names no site beside it.
  expect(html).toContain(">example.com/docs</span>");
  expect(html).not.toContain("javascript:");
});

test("a page read opens to its title and full address, not the site its line already names", () => {
  const html = renderToStaticMarkup(createElement(WebSources, { sources: [{ title: "Exponential Backoff And Jitter", url: "https://aws.amazon.com/blogs/architecture/exponential-backoff-and-jitter/" }], page: true }));
  expect(html).toContain('aria-label="Page"');
  expect(html).toContain(">Exponential Backoff And Jitter</span>");
  expect(html).toContain(">aws.amazon.com/blogs/architecture/exponential-backoff-and-jitter</span>");
});

test("a search with sources or a page read opens like a command's output; a search with none is a plain line", () => {
  const search = renderToStaticMarkup(createElement(WorkRun, { items: [web("w1", false, "Searched the web for", "fifa tickets", [{ title: "Tickets", url: "https://www.fifa.com/en/tickets" }])], artifacts: [] }));
  expect(search).toContain('aria-expanded="false"');
  expect(search).toContain(">fifa tickets</");
  const page = renderToStaticMarkup(createElement(WorkRun, { items: [web("w2", true, "Fetched", "fifa.com", [{ title: null, url: "https://www.fifa.com/en/tickets" }])], artifacts: [] }));
  expect(page).toContain('aria-expanded="false"');
  expect(page).toContain(">fifa.com</span>");
  const bare = renderToStaticMarkup(createElement(WorkRun, { items: [web("w3", false, "Searched the web for", "fifa tickets", [])], artifacts: [] }));
  expect(bare).not.toContain("aria-expanded");
});

test("a run of web steps sums up its searches and pages", () => {
  const html = renderToStaticMarkup(
    createElement(WorkRun, {
      items: [
        web("w1", false, "Searched the web for", "fifa tickets", []),
        web("w2", true, "Fetched", "fifa.com", [{ title: null, url: "https://www.fifa.com/en/tickets" }]),
        web("w3", false, "Searched the web for", "fifa resale", []),
        web("w4", true, "Fetched", "aljazeera.com", [{ title: null, url: "https://www.aljazeera.com/sports" }]),
      ],
      artifacts: [],
    }),
  );
  expect(html).toContain("Searched the web 2 times, fetched 2 pages");
});
