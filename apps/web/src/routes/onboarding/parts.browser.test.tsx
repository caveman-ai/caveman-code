// A first-task row at 390px, in Chromium: a long issue title is cut short inside its row, so Start stays inside the
// card instead of past its edge (parts.tsx Row).
import { Button } from "@caveman-app/ui/components/button";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, onTestFinished, test } from "vitest";
import { page } from "vitest/browser";
import "../../styles.css";
import { Card, Row } from "./parts.tsx";

const LONG =
  "#1482 Pasting a very long task title into the first run must not push the Start button out of its card";

async function mount(label: string, desc = "Open issue") {
  await page.viewport(390, 844);
  const host = document.createElement("div");
  host.className = "px-6";
  document.body.append(host);
  const root = createRoot(host);
  onTestFinished(async () => {
    root.unmount();
    host.remove();
    await page.viewport(1400, 900);
  });
  await act(async () =>
    root.render(
      <div className="mx-auto w-full" style={{ maxWidth: 344 }}>
        <Card title="Start with one of these">
          <Row icon={<span />} label={label} desc={desc} right={<Button size="sm">Start</Button>} />
        </Card>
      </div>,
    ),
  );
  const card = host.querySelector("section")!.getBoundingClientRect();
  const start = [...host.querySelectorAll("button")]
    .find((b) => b.textContent === "Start")!
    .getBoundingClientRect();
  const text = host.querySelector<HTMLElement>("span[title], .truncate")!;
  return { card, start, text };
}

test("at 390px a long task title is cut short and Start stays inside the card", async () => {
  const { card, start, text } = await mount(LONG);
  expect(window.innerWidth).toBeLessThanOrEqual(390);
  expect(start.right).toBeLessThanOrEqual(card.right);
  expect(start.left).toBeGreaterThanOrEqual(card.left);
  // Cut short, with the whole title one hover away.
  expect(text.scrollWidth).toBeGreaterThan(text.clientWidth);
  expect(text.getAttribute("title")).toBe(LONG);
  expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(390);
});

test("a short title is shown whole", async () => {
  const { card, start, text } = await mount("Explain this repo");
  expect(start.right).toBeLessThanOrEqual(card.right);
  expect(text.scrollWidth).toBeLessThanOrEqual(text.clientWidth);
});

test("a short label keeps its whole text, and a long description wraps under it, whole", async () => {
  const desc = "Through Caveman, or run gh auth login in a terminal, which then updates by itself";
  const { card, start, text } = await mount("Connect GitHub", desc);
  expect(start.right).toBeLessThanOrEqual(card.right);
  expect(text.scrollWidth).toBeLessThanOrEqual(text.clientWidth);
  const words = [...document.querySelectorAll("span")].find((e) => e.textContent === desc)!;
  const label = text.getBoundingClientRect();
  const box = words.getBoundingClientRect();
  // Under the label, never cut short, and inside the card.
  expect(box.top).toBeGreaterThanOrEqual(label.bottom - 1);
  expect(words.scrollWidth).toBeLessThanOrEqual(words.clientWidth);
  expect(box.right).toBeLessThanOrEqual(start.left);
  expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(390);
});

test("a short description stays beside the label", async () => {
  const { text } = await mount("Explain this repo");
  const words = [...document.querySelectorAll("span")].find((e) => e.textContent === "Open issue")!;
  expect(
    Math.abs(words.getBoundingClientRect().top - text.getBoundingClientRect().top),
  ).toBeLessThan(4);
});
