import { alerts, buttons, click, container, media } from "../../lib/dom.test-support.ts";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "vitest";
import { TurnChanges } from "./TurnChanges.tsx";

const UNDO_TITLE = "Put these files back as they were before this turn";

async function mountCard(onKeep: () => Promise<unknown>, onUndo: () => Promise<unknown>) {
  // Reduced motion: Keep asks the runtime at once rather than after the card folds shut.
  media.reducedMotion = true;
  const host = container();
  const root = createRoot(host);
  await act(async () =>
    root.render(
      createElement(TurnChanges, {
        files: [{ path: "src/a.ts", additions: 3, deletions: 1 }],
        onKeep,
        onUndo,
        onReview: null,
      }),
    ),
  );
  const undo = () => buttons(host, /^Undo/)[0]!;
  const keep = () => buttons(host, "Keep")[0]!;
  return { host, undo, keep, unmount: () => act(async () => root.unmount()) };
}

test("a Keep the runtime refuses leaves Undo usable, under its own title", async () => {
  let undos = 0;
  const card = await mountCard(
    () => Promise.reject(new Error("The connection to the runtime closed.")),
    () => {
      undos++;
      return new Promise(() => undefined);
    },
  );
  await click(card.keep());

  expect(alerts(card.host)).toEqual(["The connection to the runtime closed."]);
  expect(card.keep().disabled).toBe(false);
  expect({ disabled: card.undo().disabled, title: card.undo().title }).toEqual({
    disabled: false,
    title: UNDO_TITLE,
  });
  await click(card.undo());
  expect(undos).toBe(1);
  await card.unmount();
});

test("an Undo the runtime refuses stays off, saying why, while Keep stays offered", async () => {
  const why = "A file changed again since this turn.";
  const card = await mountCard(
    () => new Promise(() => undefined),
    () => Promise.reject(new Error(why)),
  );
  await click(card.undo());

  expect(alerts(card.host)).toEqual([why]);
  expect({ disabled: card.undo().disabled, title: card.undo().title }).toEqual({
    disabled: true,
    title: why,
  });
  expect(card.keep().disabled).toBe(false);
  await card.unmount();
});

// The Changes card after a huge turn: the runtime lists the first 200 files and counts them all (checkpoint.created files_total).
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");

test("a capped card counts every file and says how many the list leaves out", () => {
  const files = [
    { path: "vendor/a.ts", additions: 2, deletions: 1 },
    { path: "vendor/b.ts", additions: 2, deletions: 1 },
  ];
  const html = text(
    renderToStaticMarkup(
      createElement(TurnChanges, {
        files,
        total: { count: 1250, additions: 2500, deletions: 1250 },
        onReview: () => undefined,
      }),
    ),
  );
  expect(html).toContain("Changed 1,250 files");
  expect(html).toContain("+2,500");
  expect(html).toContain("−1,250");
  expect(html).toContain("1,248 more files not listed: Review shows them all");
});

test("an uncapped card counts its own list and has no such line", () => {
  const files = [{ path: "a.ts", additions: 3, deletions: 0 }];
  const html = text(renderToStaticMarkup(createElement(TurnChanges, { files, onReview: null })));
  expect(html).toContain("Changed 1 file");
  expect(html).not.toContain("not listed");
});

test("a chat in several sources lists a turn's files under their source, each path inside it; a chat in one, as they are", async () => {
  const { MemoryRouter } = await import("react-router");
  const { chatSources } = await import("../../state/sources.ts");
  const several = chatSources({
    source: "api",
    base_ref: "main",
    branch: "caveman/rename",
    pull_request: { number: 128, url: "https://github.com/acme/api/pull/128", state: "open" },
    checkouts: [
      {
        name: "web",
        repo: { url: "https://github.com/acme/web.git" },
        base_ref: "main",
        branch: "caveman/rename",
      },
    ],
  });
  const files = [
    { path: "web/src/app.ts", additions: 4, deletions: 0 },
    { path: "api/src/server.ts", additions: 3, deletions: 1 },
    { path: "api/package.json", additions: 1, deletions: 1 },
  ];
  const host = container();
  const root = createRoot(host);
  await act(async () =>
    root.render(
      createElement(
        MemoryRouter,
        null,
        createElement(TurnChanges, {
          files,
          onReview: null,
          sources: several,
          projectId: "p1",
          workspaceId: "w1",
        }),
      ),
    ),
  );
  // What the list reads, top to bottom: a source's heading as "# name", then its files.
  const read = () =>
    [...host.querySelectorAll("li")].flatMap((li) =>
      [...li.children].map((el) =>
        el.hasAttribute("data-source-heading")
          ? `# ${el.firstElementChild?.textContent}`
          : el.querySelector(".font-mono")?.textContent,
      ),
    );
  expect(read()).toEqual(["# api", "src/server.ts", "package.json", "# web", "src/app.ts"]);
  // The card names the source and its pull request; the branch the sources share is the chat's foot's to say.
  expect(host.querySelector("[data-source-heading='api']")?.textContent).toBe("api");
  expect(
    host.querySelector("[data-source-heading='api'] [role='img']")?.getAttribute("aria-label"),
  ).toBe("api: pull request #128, open");
  expect(host.textContent).toContain("Changed 3 files");
  await act(async () => root.unmount());

  // The same files in a chat in one source: no heading, every path as the runtime gave it.
  const plain = renderToStaticMarkup(createElement(TurnChanges, { files, onReview: null }));
  expect(plain).not.toContain("data-source-heading");
  expect(plain).toContain(">web/src/app.ts<");
});
