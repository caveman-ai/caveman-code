// What a chat in several sources says of itself in words (sources.ts): why it stays on its computer, naming the
// source that could never go, and what a pull request says of the others.
import { expect, test } from "vitest";

import { relatedPullRequests, sourceName, whySourcesStay, withRelated } from "./sources.ts";

const link = (host: string, full_name: string) => ({
  host,
  full_name,
  web_url: `https://${host}/${full_name}`,
  clone_url: `https://${host}/${full_name}.git`,
});
const repo = (name: string, primary: boolean, repository?: ReturnType<typeof link>) => ({
  name,
  primary,
  repoPath: `/code/${name}`,
  ...(repository ? { repository } : {}),
});

test("a chat in several sources says why it stays, naming the source that could never go", () => {
  const core = repo("core", true);
  // Every source on GitHub: a move carries one repository's files for now, and says so with the sources named.
  expect(whySourcesStay([core, repo("web", false, link("github.com", "acme/web"))])).toBe(
    "This chat stays here: it works in 2 repositories (core, web), and a move carries the files of one for now.",
  );
  // A plain folder is on its own computer alone: named first, with where it is.
  expect(
    whySourcesStay([
      core,
      repo("web", false, link("github.com", "acme/web")),
      { name: "notes", primary: false, folder: true as const, repoPath: "/Users/me/notes" },
    ]),
  ).toBe(
    "This chat stays here: it works in the folder notes (/Users/me/notes), which is on this computer alone.",
  );
  // A repository on no git host, or on another one: no other computer could check it out.
  expect(whySourcesStay([core, repo("vendor", false)])).toBe(
    "This chat stays here: vendor isn't on GitHub, so another computer can't check it out.",
  );
  expect(whySourcesStay([core, repo("mirror", false, link("gitlab.com", "acme/mirror"))])).toBe(
    "This chat stays here: mirror isn't on GitHub, so another computer can't check it out.",
  );
});

test("a pull request names the others by their pull request, or by repository and branch until one is open", () => {
  expect(relatedPullRequests([])).toBe("");
  expect(
    withRelated(
      "Both sides.",
      relatedPullRequests([
        {
          label: "acme/web",
          branch: "caveman/x",
          pull_request: { number: 3, url: "https://github.com/acme/web/pull/3" },
        },
        { label: "acme/docs", branch: "caveman/x" },
      ]),
    ),
  ).toBe(
    "Both sides.\n\nPart of one change across 3 repositories. The others:\n- acme/web: https://github.com/acme/web/pull/3\n- acme/docs: branch `caveman/x`",
  );
  expect(withRelated(undefined, "")).toBe("");
});

test("a source's folder name is one safe path segment, unique in its project", () => {
  expect(sourceName("web.git", new Set())).toBe("web");
  expect(sourceName("My App!", new Set())).toBe("My-App");
  expect(sourceName("web", new Set(["web"]))).toBe("web-2");
  expect(sourceName("..", new Set())).toBe("source");
});
