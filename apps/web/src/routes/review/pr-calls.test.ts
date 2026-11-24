// The pull request bar's Review call to the host, rendered as the person sees it, with no DOM.
import { createElement, type ComponentProps, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, test, vi } from "vitest";

// Every Button's props, so a test can press one; the popover's content drawn in place, as if open.
const buttons = vi.hoisted(() => [] as Array<{ children?: ReactNode; onClick?: () => void }>);
vi.mock("@caveman-app/ui/components/button", async (importOriginal) => {
  const real = await importOriginal<typeof import("@caveman-app/ui/components/button")>();
  return {
    ...real,
    Button: (props: ComponentProps<typeof real.Button>) => (
      buttons.push(props as never),
      createElement(real.Button, props)
    ),
  };
});
vi.mock("@caveman-app/ui/components/popover", () => ({
  Popover: ({ children }: { children: ReactNode }) => children,
  PopoverTrigger: ({ children }: { children: ReactNode }) => children,
  PopoverContent: ({ children }: { children: ReactNode }) => createElement("div", null, children),
}));
import { ReviewMenu } from "./PrPage.tsx";

test("a second Submit while the first review is out (a held or repeated ⌘↩) posts no second review", () => {
  buttons.length = 0;
  const sent: string[] = [];
  // The first review is still on its way to the host.
  renderToStaticMarkup(
    createElement(ReviewMenu, {
      onSubmit: (verdict) => (sent.push(verdict), new Promise(() => undefined)),
    }),
  );
  const submit = buttons.find((b) => b.children === "Submit review")!;
  submit.onClick!();
  submit.onClick!();
  expect(sent).toEqual(["approve"]);
});
