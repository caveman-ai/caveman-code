// A throw above the router (the runtime provider, and what it works out from Cloud's list) in Chromium: the window says
// what broke and offers Reload and a report, on its own background. In 0.1.5 the runtime provider threw on a Cloud list
// with two Macs Cloud had never heard from, nothing caught it, and a Mac's see-through window showed only the desktop.
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, onTestFinished, test } from "vitest";
import "../styles.css";
import { AppErrorBoundary } from "./RouteError.tsx";

function ThrowsLikeTheRuntimeProvider(): never {
  // What 0.1.5 threw: last_seen_at null under a sort that took it for a string.
  throw new TypeError("Cannot read properties of null (reading 'localeCompare')");
}

test("a throw above the router shows what broke, Reload and a report, never a blank window", async () => {
  // The Mac's dark window: the page's body is see-through (styles.css html.dark[data-desktop]).
  document.documentElement.classList.add("dark");
  document.documentElement.dataset.desktop = "";
  const host = document.createElement("div");
  host.style.height = "600px";
  document.body.append(host);
  const root = createRoot(host);
  const quiet = console.error;
  console.error = () => undefined;
  onTestFinished(() => {
    console.error = quiet;
    root.unmount();
    host.remove();
    delete document.documentElement.dataset.desktop;
  });
  await act(async () =>
    root.render(
      <AppErrorBoundary>
        <ThrowsLikeTheRuntimeProvider />
      </AppErrorBoundary>,
    ),
  );
  const alert = host.querySelector('[role="alert"]');
  expect(alert?.querySelector("h1")?.textContent).toBe("Something broke in this window");
  expect(alert?.textContent).toContain(
    "TypeError: Cannot read properties of null (reading 'localeCompare')",
  );
  // Its own background: nothing of the desktop behind the window shows through.
  expect(getComputedStyle(alert!).backgroundColor).toMatch(/^rgb\(/);
  const button = (name: string) =>
    [...host.querySelectorAll("button")].find((b) => b.textContent === name);
  expect(button("Reload")).toBeDefined();
  // Report opens the report preview though the runtime provider is gone.
  await act(async () => button("Report a problem")!.click());
  await expect
    .poll(() =>
      [...document.querySelectorAll('[role="dialog"]')].some((d) =>
        d.textContent?.includes("Report a problem"),
      ),
    )
    .toBe(true);
});
