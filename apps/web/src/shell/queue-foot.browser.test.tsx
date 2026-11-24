// The sidebar's queue view, in Chromium, against the scripted runtime: what is over (Done, Snoozed, Archived) sits at
// the column's foot, however little is live above it.
import { expect, test } from "vitest";
import { page, userEvent } from "vitest/browser";
import { mountApp } from "../../test/app.tsx";
import { runtimeFixture, workspace } from "../../test/fixtures.ts";

const sidebar = () => page.getByRole("complementary", { name: "Sidebar" });

test("Done and Archived sit at the foot of a short queue, not under its last live chat", async () => {
  const done = new Date(Date.now() - 3_600_000).toISOString();
  await mountApp(
    "/new",
    runtimeFixture({
      workspaces: [
        workspace("ws-live", { title: "Fix the login redirect", status: "working" }),
        workspace("ws-done", { title: "Add dark mode", inbox: { done_at: done } }),
        workspace("ws-gone", { title: "Old spike", status: "archived" }),
      ],
    }),
  );
  await userEvent.click(sidebar().getByRole("button", { name: /^Queue/ }));
  const working = sidebar().getByRole("region", { name: "Working" });
  const doneShelf = sidebar().getByRole("region", { name: "Done" });
  const archived = sidebar().getByRole("region", { name: "Archived" });
  await expect.element(working).toBeVisible();
  await expect.element(archived).toBeVisible();

  const column = doneShelf.element().parentElement!.parentElement!;
  const foot =
    column.getBoundingClientRect().bottom -
    Number.parseFloat(getComputedStyle(column).paddingBottom);
  // Archived is the last shelf, flush with the column's foot; Done is right above it.
  expect(Math.abs(archived.element().getBoundingClientRect().bottom - foot)).toBeLessThanOrEqual(1);
  expect(doneShelf.element().getBoundingClientRect().bottom).toBeLessThanOrEqual(
    archived.element().getBoundingClientRect().top + 1,
  );
  // A short live list leaves room between it and what is over.
  expect(
    doneShelf.element().getBoundingClientRect().top -
      working.element().getBoundingClientRect().bottom,
  ).toBeGreaterThan(200);
});

test("a finished chat waits in Ready for review until it is called done; Done lists the called-done, newest first", async () => {
  const ago = (hours: number) => new Date(Date.now() - hours * 3_600_000).toISOString();
  await mountApp(
    "/new",
    runtimeFixture({
      workspaces: [
        // Finished with nothing to land: it is still the person's to read.
        workspace("ws-answer", {
          title: "Explain the cache layer",
          status: "idle",
          updated_at: ago(0.2),
        }),
        // Called done long ago, but touched since: its place in Done is by when it was called done.
        workspace("ws-old", {
          title: "Bump the lockfile",
          inbox: { done_at: ago(30) },
          updated_at: ago(0.1),
        }),
        workspace("ws-new", {
          title: "Add dark mode",
          inbox: { done_at: ago(2) },
          updated_at: ago(5),
        }),
      ],
    }),
  );
  await userEvent.click(sidebar().getByRole("button", { name: /^Queue/ }));
  const review = sidebar().getByRole("region", { name: "Ready for review" });
  await expect.element(review.getByText("Explain the cache layer")).toBeVisible();
  const doneShelf = sidebar().getByRole("region", { name: "Done" });
  await userEvent.click(doneShelf.getByRole("button", { name: "Done", exact: true }), {
    position: { x: 8, y: 8 },
  });
  await expect.element(doneShelf.getByText("Bump the lockfile")).toBeVisible();
  const titles = [...doneShelf.element().querySelectorAll("[data-peek] .truncate")].map(
    (e) => e.textContent,
  );
  expect(titles).toEqual(["Add dark mode", "Bump the lockfile"]);
  expect(doneShelf.getByText("Explain the cache layer").query()).toBeNull();
});

test("Done and Archived stay newest first without date headings", async () => {
  const at = (days: number) => {
    const day = new Date();
    day.setDate(day.getDate() - days);
    day.setHours(10, 0, 0, 0);
    return day.toISOString();
  };
  await mountApp(
    "/new",
    runtimeFixture({
      workspaces: [
        workspace("done-old", {
          title: "Older completion",
          inbox: { done_at: at(1) },
          updated_at: at(0),
        }),
        workspace("done-new", {
          title: "Newest completion",
          inbox: { done_at: at(0) },
          updated_at: at(2),
        }),
        workspace("archive-old", { title: "Older archive", status: "archived", updated_at: at(1) }),
        workspace("archive-new", {
          title: "Newest archive",
          status: "archived",
          updated_at: at(0),
        }),
      ],
    }),
  );
  await userEvent.click(sidebar().getByRole("button", { name: /^Queue/ }));
  for (const label of ["Done", "Archived"]) {
    const shelf = sidebar().getByRole("region", { name: label, exact: true });
    await userEvent.click(shelf.getByRole("button", { name: label, exact: true }), {
      position: { x: 8, y: 8 },
    });
    const title = label === "Done" ? "Newest completion" : "Newest archive";
    await expect.element(shelf.getByText(title, { exact: true })).toBeVisible();
    const order = [...shelf.element().querySelectorAll("[data-peek] .truncate")].map(
      (e) => e.textContent,
    );
    expect(order).toEqual(
      label === "Done"
        ? ["Newest completion", "Older completion"]
        : ["Newest archive", "Older archive"],
    );
    expect(shelf.element().querySelector("h3")).toBeNull();
    await userEvent.click(shelf.getByRole("button", { name: label, exact: true }), {
      position: { x: 8, y: 8 },
    });
    expect(shelf.getByRole("heading", { name: "Today", exact: true }).query()).toBeNull();
  }
});
