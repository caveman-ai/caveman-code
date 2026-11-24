// The working ring in Chromium: every ring on screen shows the same frame, however far apart they mounted and whatever
// hid one for a while (a folder shut, a sidebar folded, a pane put away). Hiding a box ends its CSS animations and
// showing it starts them over from that moment, so a ring that came back would turn out of step with the rest.
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, onTestFinished, test } from "vitest";
import type { ChatStatus } from "../state/model.ts";
import "../styles.css";
import { StatusMark } from "./StatusMark.tsx";

const WORKING: ChatStatus = {
  id: "working",
  label: "Working",
  detail: null,
  action: false,
  since: null,
  progress: null,
  agents: 0,
};

const frame = () => new Promise((done) => requestAnimationFrame(() => done(null)));
const wait = (ms: number) => new Promise((done) => setTimeout(done, ms));
/** Each ring's loop: when it started, on the document's clock. */
const starts = (host: Element) =>
  [...host.querySelectorAll(".px-strip-track")].map((track) =>
    track.getAnimations().map((loop) => loop.startTime),
  );

test("a ring hidden and shown again turns in step with the rest", async () => {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  onTestFinished(() => {
    root.unmount();
    host.remove();
  });
  await act(async () =>
    root.render(
      <>
        <div>
          <StatusMark status={WORKING} />
        </div>
        <div data-folder>
          <StatusMark status={WORKING} />
        </div>
      </>,
    ),
  );
  expect(starts(host)).toEqual([[0], [0]]);

  // Shut and opened again by CSS alone, the way a folder or a folded sidebar hides its rows: React re-renders nothing.
  const folder = host.querySelector<HTMLElement>("[data-folder]")!;
  await wait(200);
  folder.style.display = "none";
  // Read styles, so the browser applies the hide before the show (a person sees the folder shut first).
  getComputedStyle(folder).display;
  await frame();
  folder.style.display = "";
  await frame();
  await frame();
  expect(starts(host)).toEqual([[0], [0]]);
});
