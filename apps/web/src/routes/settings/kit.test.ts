import { readdirSync, readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { SettingsCard, SettingsPage } from "./rows.tsx";

// Every Settings section is built from rows.tsx (packages/ui/STYLE.md,
// "Settings"): the shell sets the width and the title, the kit draws cards,
// headings and rows. A section that hand-lays any of them fails here.
const dir = new URL("./", import.meta.url);
const sections = [
  ...readdirSync(dir)
    .filter((f) => f.endsWith(".tsx") && f !== "rows.tsx")
    .map((f) => new URL(f, dir)),
  new URL("../../components/RemoteControl.tsx", import.meta.url),
  new URL("../../components/DesktopAppSettings.tsx", import.meta.url),
];
const HAND_LAID: ReadonlyArray<[RegExp, string]> = [
  [/max-w-\[\d+px\]/, "sets its own width"],
  [/<section[\s>]/, "draws its own section"],
  [/<h[1-3][\s>]/, "draws its own heading"],
  [/rounded-xl border border-border bg-card/, "draws its own card"],
];

describe("settings sections use the kit", () => {
  for (const file of sections) {
    it(file.pathname.split("/").pop()!, () => {
      const source = readFileSync(file, "utf8");
      for (const [pattern, what] of HAND_LAID) expect(pattern.test(source), `${what}: ${pattern}`).toBe(false);
    });
  }
});

// One control size and one control width (STYLE.md, "Settings"): a `<Button>` at its default 32px, and a select, field
// or model picker at the kit's CONTROL / PICKER width. The files Settings draws from outside this folder count too.
const controls = [
  ...sections,
  new URL("../../components/Devices.tsx", import.meta.url),
  new URL("../Secrets.tsx", import.meta.url),
  new URL("../EngineAccounts.tsx", import.meta.url),
];
// What the list pages draw (sections.ts, `wide`: Plan, Models & keys, Computers, Environments). Their rows are 44px
// on hairlines, so the small button is theirs; nowhere else in Settings.
const LIST_PAGES = new Set(["Plan.tsx", "ModelsAndKeys.tsx", "CavemanProviders.tsx", "WebSearchKeys.tsx", "Connections.tsx", "EngineAccounts.tsx", "Computers.tsx", "Environments.tsx"]);
const SMALL_BUTTON = /<Button\b[^>]*\bsize="sm"/;

describe("settings controls are one size", () => {
  for (const file of controls) {
    const name = file.pathname.split("/").pop()!;
    it(name, () => {
      const source = readFileSync(file, "utf8");
      if (!LIST_PAGES.has(name)) expect(SMALL_BUTTON.test(source), `shrinks a button: ${SMALL_BUTTON}`).toBe(false);
      expect(source, "uses a second control width").not.toContain("CONTROL_WIDE");
      // Every model picker a section draws wears the kit's PICKER, never its own classes.
      expect(source.split("className={PICKER}").length, "a model picker without PICKER").toBe(source.split("<ModelPicker").length);
    });
  }
});

// The small grey label on the page's edge is Settings' own. The automation editor, an agent's page and the Chief's
// sheet build from the same cards beside their own 14px h3 headings: there a card's heading stays that heading.
describe("a card's heading follows the page it is on", () => {
  const card = createElement(SettingsCard, { title: "Session", description: "A line.", children: "rows" });

  it("in Settings: a small grey h2 on the page's edge", () => {
    const html = renderToStaticMarkup(createElement(SettingsPage, { title: "General", children: card }));
    expect(html).toMatch(/<h2[^>]*class="text-\[12\.5px\] font-normal text-muted-foreground"[^>]*>Session<\/h2>/);
    expect(html).toMatch(/<header class="[^"]*px-\[21px\][^"]*">/);
    expect(html).not.toContain("<h3");
  });

  it("anywhere else: the 14px h3 those pages use, with no inset", () => {
    const html = renderToStaticMarkup(card);
    expect(html).toMatch(/<h3[^>]*class="text-\[14px\] font-medium"[^>]*>Session<\/h3>/);
    expect(html).not.toContain("px-[21px]");
    expect(html).not.toContain("<h2");
    expect(html).toContain('<p class="mt-0.5 text-[13px] leading-5 text-muted-foreground">A line.</p>');
  });
});
