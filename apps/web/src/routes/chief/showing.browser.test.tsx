import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, onTestFinished, test, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { useLongPress } from "../../lib/long-press.ts";
import type { WorkspaceView } from "../../state/model.ts";
import "../../styles.css";
import { PreviewChip } from "./showing.tsx";

const { call } = vi.hoisted(() => ({ call: vi.fn() }));
vi.mock("../../state/runtime.tsx", () => ({
  useRuntimeClient: () => ({ client: { call } }),
  requestId: () => "preview-regression",
}));
vi.mock("../../panels/browser/BrowserBar.tsx", () => ({ openSoon: () => () => undefined }));

const command = `node /very/long/checkout/${"nested-directory/".repeat(14)}server.mjs`;
const reason = "exited (code 23) before it listened on port 42100.";
const message = `\`${command}\` ${reason}\nBuild failed. Select this error to copy it.`;
const chat = {
  id: "preview-chat",
  preview: { command, path: "/" },
} as WorkspaceView;
const details = () => page.getByRole("status", { name: "Preview failure details" });
const chip = () => page.getByRole("button", { name: /Open preview|Preview failed/ }).first();

async function mount({ compact = true, label }: { compact?: boolean; label?: string } = {}) {
  const requests: Array<{ reject: (error: Error) => void }> = [];
  call
    .mockReset()
    .mockImplementation(() => new Promise((_resolve, reject) => requests.push({ reject })));
  const menu = vi.fn();
  const drag = vi.fn();
  function Row() {
    const hold = useLongPress(menu);
    return (
      <div
        {...hold}
        onContextMenu={(event) => {
          event.preventDefault();
          menu();
        }}
        onDragStart={drag}
      >
        <div style={{ width: 272 }}>
          <PreviewChip chat={chat} compact={compact} {...(label ? { label } : {})} />
        </div>
        <button type="button">Elsewhere</button>
      </div>
    );
  }
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  onTestFinished(() => {
    root.unmount();
    host.remove();
  });
  await act(async () => root.render(<Row />));
  const fail = async (failureMessage = message) => {
    await act(async () => requests.shift()!.reject(new Error(failureMessage)));
    await expect.element(chip()).toHaveTextContent(compact ? "" : "Preview failed");
    expect(chip().element().getAttribute("aria-label")).toMatch(/^Preview failed/);
  };
  return { fail, menu, drag };
}

test("failure details preserve native copy and selection without board context menus, holds or drags", async () => {
  const { fail, menu, drag } = await mount();
  await userEvent.click(chip());
  await fail();
  await userEvent.click(chip());
  const text = details().element();
  const context = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
  text.dispatchEvent(context);
  expect.soft(context.defaultPrevented).toBe(false);
  expect.soft(menu).not.toHaveBeenCalled();
  menu.mockClear();
  const press = new PointerEvent("pointerdown", {
    bubbles: true,
    cancelable: true,
    pointerType: "touch",
    pointerId: 1,
    isPrimary: true,
  });
  text.dispatchEvent(press);
  await new Promise((resolve) => setTimeout(resolve, 500));
  text.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, pointerId: 1 }));
  expect.soft(press.defaultPrevented).toBe(false);
  expect.soft(menu).not.toHaveBeenCalled();
  const dragStart = new Event("dragstart", { bubbles: true, cancelable: true });
  text.dispatchEvent(dragStart);
  expect.soft(drag).not.toHaveBeenCalled();
  expect.soft(dragStart.defaultPrevented).toBe(false);
  const range = document.createRange();
  range.selectNodeContents(text);
  window.getSelection()!.removeAllRanges();
  window.getSelection()!.addRange(range);
  expect(window.getSelection()!.toString()).toContain("Select this error to copy it.");
});

test("failed and restarted compact chips retain local focus without stealing focus after navigation", async () => {
  const { fail } = await mount();
  await userEvent.click(chip());
  await fail();
  expect.soft(document.activeElement).toBe(chip().element());
  await userEvent.click(chip());
  await userEvent.click(page.getByRole("button", { name: "Retry", exact: true }));
  expect.soft(document.activeElement).toBe(chip().element());
  // Moving away while the request is pending must win over the later failure.
  const elsewhere = page.getByRole("button", { name: "Elsewhere" }).element() as HTMLElement;
  elsewhere.focus();
  await fail();
  expect(document.activeElement).toBe(elsewhere);
  // Also leave the disclosure after Retry, before the next failure arrives.
  await userEvent.click(chip());
  await userEvent.click(page.getByRole("button", { name: "Retry", exact: true }));
  elsewhere.focus();
  await fail();
  expect(document.activeElement).toBe(elsewhere);
});

test.each(["Customer portal", "Admin console", undefined])(
  "failed inline chips keep preview identity in accessible retry name: %s",
  async (label) => {
    const { fail } = await mount({ compact: false, ...(label ? { label } : {}) });
    await expect
      .element(chip())
      .toHaveAccessibleName(label ? `Open preview of ${label}` : "Open preview");
    await userEvent.click(chip());
    await fail();
    expect(chip().element()).toHaveAccessibleName(
      label ? `Preview failed for ${label}: retry` : "Preview failed: retry",
    );
  },
);

test.each(["code 23", "SIGTERM"])(
  "narrow failure headers paint %s and port while only the long command truncates",
  async (exit) => {
    await page.viewport(320, 800);
    onTestFinished(() => page.viewport(1400, 900));
    const { fail } = await mount();
    await userEvent.click(chip());
    const summary = `exited (${exit}) before it listened on port 42100.`;
    await fail(`\`${command}\` ${summary}\nBuild failed.`);
    await userEvent.click(chip());
    const status = details().element();
    const header = status.previousElementSibling!;
    expect(header.textContent).toContain(summary);
    // Read every essential character's painted box, including ancestor clipping and ellipsis.
    const walker = document.createTreeWalker(header, NodeFilter.SHOW_TEXT);
    const bounds = header.getBoundingClientRect();
    let painted = "";
    while (walker.nextNode()) {
      const node = walker.currentNode;
      for (let i = 0; i < node.textContent!.length; i++) {
        const range = document.createRange();
        range.setStart(node, i);
        range.setEnd(node, i + 1);
        const box = range.getBoundingClientRect();
        if (box.left >= bounds.left && box.right <= bounds.right && box.bottom <= bounds.bottom) {
          painted += node.textContent![i];
        }
      }
    }
    expect(painted).toContain(summary);
    expect(header.querySelector("[title]")?.getAttribute("title")).toContain(command);
  },
);
