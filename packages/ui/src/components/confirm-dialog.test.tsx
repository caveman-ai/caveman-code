import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ConfirmDialog } from "./confirm-dialog";

// Exercise the actual component's focus callbacks without adding a DOM dependency.
// The real Radix focus lifecycle is also checked in a browser.
const content = vi.hoisted(() => ({
  props: {} as React.ComponentProps<typeof import("./dialog").DialogContent>,
}));
vi.mock("./dialog", () => ({
  Dialog: ({ children }: { children: React.ReactNode }) => children,
  DialogContent: (props: typeof content.props) => {
    content.props = props;
    return null;
  },
  DialogDescription: () => null,
  DialogFooter: () => null,
  DialogHeader: () => null,
  DialogTitle: () => null,
}));

class FocusTarget {
  isConnected = true;
  focus = vi.fn();
  closest = vi.fn().mockReturnValue(null);
  getAttribute = vi.fn().mockReturnValue(null);
}

function render(onCloseAutoFocus?: (event: Event) => void) {
  vi.stubGlobal("HTMLElement", FocusTarget);
  const opener = new FocusTarget();
  const document = { activeElement: opener as FocusTarget | null, getElementById: vi.fn() };
  vi.stubGlobal("document", document);
  renderToStaticMarkup(
    <ConfirmDialog
      open
      onOpenChange={() => {}}
      title="Delete item?"
      description="The item will be deleted."
      onConfirm={() => {}}
      onCloseAutoFocus={onCloseAutoFocus}
    />,
  );
  return { opener, document };
}

function open() {
  const event = new Event("openAutoFocus", { cancelable: true });
  expect(content.props.onOpenAutoFocus).toBeTypeOf("function");
  content.props.onOpenAutoFocus!(event);
  expect(event.defaultPrevented).toBe(false); // Keep Radix's initial focus behavior.
}

function close() {
  const event = new Event("closeAutoFocus", { cancelable: true });
  content.props.onCloseAutoFocus?.(event);
  return event;
}

afterEach(() => vi.unstubAllGlobals());

describe("ConfirmDialog focus without a DialogTrigger", () => {
  it("captures the opener before Radix moves focus and restores it on close", () => {
    const { opener, document } = render();
    open();
    document.activeElement = new FocusTarget(); // Radix focuses Cancel after opening.
    expect(close().defaultPrevented).toBe(true);
    expect(opener.focus).toHaveBeenCalledOnce();
    expect(document.activeElement.focus).not.toHaveBeenCalled();
  });

  it("captures a fresh opener on every opening", () => {
    const { opener, document } = render();
    open();
    close();
    const nextOpener = new FocusTarget();
    document.activeElement = nextOpener;
    open();
    close();
    expect(opener.focus).toHaveBeenCalledOnce();
    expect(nextOpener.focus).toHaveBeenCalledOnce();
  });

  it("returns to a menu's persistent trigger instead of its removed item", () => {
    const { opener: item, document } = render();
    const trigger = new FocusTarget();
    trigger.getAttribute.mockReturnValue("menu");
    item.closest.mockReturnValue({ getAttribute: () => "menu-trigger" });
    document.getElementById.mockReturnValue(trigger);
    open();
    item.isConnected = false; // Dropdown content unmounts while the dialog opens.
    close();
    expect(trigger.focus).toHaveBeenCalledOnce();
    expect(item.focus).not.toHaveBeenCalled();
  });

  it("does not try to focus a removed opener", () => {
    const { opener } = render();
    open();
    opener.isConnected = false;
    close();
    expect(opener.focus).not.toHaveBeenCalled();
  });

  it("forgets an earlier opener when there is no HTML focus target", () => {
    const { opener, document } = render();
    open();
    close();
    document.activeElement = null;
    open();
    close();
    expect(opener.focus).toHaveBeenCalledOnce();
  });

  it.each([false, true])("leaves an explicit caller callback in control (preventDefault=%s)", (preventDefault) => {
    const callback = vi.fn((event: Event) => {
      if (preventDefault) event.preventDefault();
    });
    const { opener } = render(callback);
    open();
    const event = close();
    expect(callback).toHaveBeenCalledExactlyOnceWith(event);
    expect(event.defaultPrevented).toBe(preventDefault);
    expect(opener.focus).not.toHaveBeenCalled();
  });
});
