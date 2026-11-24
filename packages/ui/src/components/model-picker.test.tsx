import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ModelPicker, type ModelPickerProps, type PickerEngine } from "./model-picker";
import { PopoverContent } from "./popover";

/*
 * No DOM. The composer's picker, open, runs inline in one server-rendered component: ModelPicker and the body inside
 * its popover are called as functions, so their hooks are that component's. A handler a step calls during the render
 * (a rail tap, a star, a keystroke) sets state, so the component renders again with every hook kept, as a mounted
 * picker re-renders; each pass hands what the body rendered to the next step.
 */
type Node = React.ReactElement<Record<string, unknown>>;
type Pass = { view: Node; content: Node; search: { current: unknown } };

function find(node: unknown, hit: (el: Node) => boolean): Node | undefined {
  if (Array.isArray(node)) {
    for (const n of node) {
      const el = find(n, hit);
      if (el) return el;
    }
    return undefined;
  }
  if (!React.isValidElement(node)) return undefined;
  const el = node as Node;
  return hit(el) ? el : find(el.props.children, hit);
}

function composer({
  catalog,
  steps,
  ...props
}: {
  catalog: () => PickerEngine[];
  steps: Array<(pass: Pass) => void>;
} & Partial<ModelPickerProps>): Pass[] {
  const passes: Pass[] = [];
  function Composer() {
    const [favorites, setFavorites] = React.useState<string[]>([]);
    const picker = ModelPicker({
      value: null,
      onChange: () => {},
      open: true,
      onOpenChange: () => {},
      ...props,
      engines: catalog(),
      favorites,
      onFavoritesChange: setFavorites,
    });
    const content = find(picker, (el) => el.type === PopoverContent);
    const body = content?.props.children as Node | undefined;
    if (!content || !body) throw new Error("the picker rendered no popover body");
    const pass = {
      view: (body.type as (p: unknown) => Node)(body.props),
      content,
      search: body.props.inputRef as { current: unknown },
    };
    passes.push(pass);
    steps[passes.length - 1]?.(pass);
    return null;
  }
  renderToStaticMarkup(<Composer />);
  return passes;
}

const tapTile = (pass: Pass, section: string) =>
  (find(pass.view, (el) => Array.isArray(el.props.tiles))!.props.onSelect as (s: string) => void)(
    section,
  );
const star = (pass: Pass, model: string) =>
  (
    find(
      pass.view,
      (el) => (el.props.entry as { model?: { id: string } } | undefined)?.model?.id === model,
    )!.props.onStar as () => void
  )();
const searchField = (pass: Pass) =>
  find(pass.view, (el) => el.type === "input" && el.props["aria-label"] === "Search models")!.props;
// The height is the row's that holds the rail and the list (so a short window shrinks both), not the list's own.
const listHeight = (pass: Pass) =>
  (
    find(
      pass.view,
      (el) =>
        (el.props.style as { height?: number } | undefined)?.height !== undefined &&
        find(el.props.children, (child) => child.props.role === "listbox") !== undefined,
    )!.props.style as { height?: number }
  ).height;
const listedModels = (pass: Pass) => {
  const list = find(pass.view, (el) => el.props.role === "listbox")!.props.children;
  return (Array.isArray(list) ? list : []).filter((el: Node) => el.props.entry !== undefined)
    .length;
};

const m = (id: string, label: string) => ({
  id,
  label,
  efforts: ["low", "medium", "high"],
  default_effort: "medium",
});

afterEach(() => vi.unstubAllGlobals());

describe("ModelPicker on a touch screen", () => {
  const catalog = (): PickerEngine[] => [
    { id: "claude", label: "Claude Agent", models: [m("claude-opus", "Claude Opus")] },
    { id: "codex", label: "Codex", models: [m("gpt-5", "GPT-5")] },
  ];

  function browse(hoverNone: boolean) {
    vi.stubGlobal("matchMedia", (q: string) => ({ matches: hoverNone && q === "(hover: none)" }));
    const focus = vi.fn();
    const focused: number[] = [];
    composer({
      catalog,
      value: { engine: "claude", model: "claude-opus" },
      steps: [
        (pass) => {
          pass.search.current = { focus };
          (pass.content.props.onOpenAutoFocus as (e: { preventDefault(): void }) => void)({
            preventDefault() {},
          });
          focused.push(focus.mock.calls.length);
          tapTile(pass, "codex");
        },
        () => focused.push(focus.mock.calls.length),
      ],
    });
    return focused;
  }

  it("browsing a harness from the rail leaves the search unfocused, so no keyboard covers the picker", () => {
    expect(browse(true)).toEqual([0, 0]);
  });

  it("on a pointer screen the search takes focus on open and keeps it through a rail tap", () => {
    expect(browse(false)).toEqual([1, 2]);
  });
});

describe("ModelPicker search with an input method", () => {
  const catalog = (): PickerEngine[] => [
    {
      id: "claude",
      label: "Claude Agent",
      models: [m("claude-opus-4-1", "Opus 4.1"), m("claude-opus-4", "Opus 4")],
    },
  ];
  const enter = (nativeEvent: { isComposing: boolean; keyCode: number }) => ({
    key: "Enter",
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    nativeEvent,
    preventDefault() {},
  });

  function typeThenEnter(nativeEvent: { isComposing: boolean; keyCode: number }) {
    const onChange = vi.fn();
    const onOpenChange = vi.fn();
    composer({
      catalog,
      onChange,
      onOpenChange,
      steps: [
        (pass) =>
          (searchField(pass).onChange as (e: unknown) => void)({ target: { value: "opus" } }),
        (pass) => (searchField(pass).onKeyDown as (e: unknown) => void)(enter(nativeEvent)),
      ],
    });
    return { onChange, onOpenChange };
  }

  it.each([
    [
      "Safari (compositionend first: keyCode 229, not composing)",
      { isComposing: false, keyCode: 229 },
    ],
    ["Chromium (still composing)", { isComposing: true, keyCode: 229 }],
  ])(
    "the Enter that commits the composed text picks nothing and keeps the picker open: %s",
    (_, native) => {
      const { onChange, onOpenChange } = typeThenEnter(native);
      expect(onChange).not.toHaveBeenCalled();
      expect(onOpenChange).not.toHaveBeenCalled();
    },
  );

  it("a plain Enter picks the first match and closes", () => {
    const { onChange, onOpenChange } = typeThenEnter({ isComposing: false, keyCode: 13 });
    expect(onChange).toHaveBeenCalledExactlyOnceWith({
      engine: "claude",
      model: "claude-opus-4-1",
    });
    expect(onOpenChange).toHaveBeenCalledExactlyOnceWith(false);
  });
});

describe("ModelPicker list height", () => {
  // Home (the default Opus, Auto, the credits Sonnet, Sonnet, GPT-A, GPT-B) is the tallest section: 12 + 6 * 32 = 204px.
  const catalog = (codex = ["gpt-a", "gpt-b", "gpt-c"]): PickerEngine[] => [
    {
      id: "caveman",
      label: "Caveman",
      models: [m("auto", "Auto"), m("caveman/anthropic/claude-sonnet", "Claude Sonnet (credits)")],
    },
    {
      id: "claude",
      label: "Claude Agent",
      models: [m("opus", "Opus"), m("sonnet", "Sonnet"), m("haiku", "Haiku")],
    },
    { id: "codex", label: "Codex", models: codex.map((id) => m(id, id.toUpperCase())) },
  ];
  const opus = { engine: "claude", model: "opus" };

  it("a star does not move the popover's edge, though the composer builds the catalog afresh on every render", () => {
    const heights: Array<number | undefined> = [];
    let homeRows = 0;
    composer({
      catalog: () => catalog(),
      value: opus,
      defaultModel: opus,
      steps: [
        (pass) => {
          heights.push(listHeight(pass));
          tapTile(pass, "claude");
        },
        (pass) => {
          heights.push(listHeight(pass));
          star(pass, "haiku");
        },
        (pass) => {
          heights.push(listHeight(pass));
          tapTile(pass, "home");
        },
        (pass) => {
          heights.push(listHeight(pass));
          homeRows = listedModels(pass);
        },
      ],
    });
    // Haiku is on Home now, a seventh row the list scrolls to rather than grows for.
    expect({ heights, homeRows }).toEqual({ heights: [204, 204, 204, 204], homeRows: 7 });
  });

  it("a catalog that changes while the picker is open is measured again", () => {
    let models = ["gpt-a", "gpt-b", "gpt-c"];
    const heights: Array<number | undefined> = [];
    composer({
      catalog: () => catalog(models),
      value: opus,
      defaultModel: opus,
      steps: [
        (pass) => {
          heights.push(listHeight(pass));
          models = ["gpt-a", "gpt-b", "gpt-c", "gpt-d", "gpt-e", "gpt-f"];
          tapTile(pass, "codex");
        },
        (pass) => heights.push(listHeight(pass)),
      ],
    });
    // Codex is the tallest section now: a heading and six rows, 12 + 28 + 6 * 32.
    expect(heights).toEqual([204, 232]);
  });
});

describe("ModelPicker with an engine whose models cannot be picked yet", () => {
  const connect = vi.fn();
  const lock = {
    title: "Connect your Claude plan to use Claude Agent in Cloud.",
    action: { label: "Connect Claude", run: connect },
  };
  const catalog = (models = [m("opus", "Opus")]): PickerEngine[] => [
    { id: "caveman", label: "Caveman", models: [m("auto", "Auto")] },
    { id: "claude", label: "Claude Agent", models, locked: lock },
  ];
  const row = (pass: Pass, model: string) =>
    find(
      pass.view,
      (el) => (el.props.entry as { model?: { id: string } } | undefined)?.model?.id === model,
    )!.props as { locked: boolean; onPick: () => void; onStar?: () => void };
  const action = (pass: Pass) =>
    find(
      pass.view,
      (el) => (el.props.action as { label?: string } | undefined)?.label === "Connect Claude",
    )?.props.action as { run: () => void } | undefined;

  it("lists them greyed and picks none of them, and the list ends in the way to them", () => {
    const picked = vi.fn();
    const closed = vi.fn();
    let greyed: boolean | undefined;
    let starless: boolean | undefined;
    let open: boolean | undefined;
    composer({
      catalog: () => catalog(),
      value: { engine: "caveman", model: "auto" },
      onChange: picked,
      onOpenChange: closed,
      steps: [
        (pass) => tapTile(pass, "claude"),
        (pass) => {
          greyed = row(pass, "opus").locked;
          starless = row(pass, "opus").onStar === undefined;
          row(pass, "opus").onPick();
          open = action(pass) !== undefined;
          action(pass)?.run();
        },
      ],
    });
    expect({ greyed, starless, open }).toEqual({ greyed: true, starless: true, open: true });
    expect(picked).not.toHaveBeenCalled();
    // Its button leaves the picker for where it leads.
    expect(closed).toHaveBeenCalledWith(false);
    expect(connect).toHaveBeenCalledTimes(1);
  });

  it("another engine's models pick as ever, with no lock under them", () => {
    const picked = vi.fn();
    let lockShown: boolean | undefined;
    composer({
      catalog: () => catalog(),
      value: null,
      onChange: picked,
      steps: [
        (pass) => tapTile(pass, "caveman"),
        (pass) => {
          lockShown = action(pass) !== undefined;
          row(pass, "auto").onPick();
        },
      ],
    });
    expect(lockShown).toBe(false);
    expect(picked).toHaveBeenCalledWith({ engine: "caveman", model: "auto" });
  });

  it("with no model to list, the words stand alone over the button", () => {
    let title: unknown;
    composer({
      catalog: () => catalog([]),
      value: { engine: "caveman", model: "auto" },
      steps: [
        (pass) => tapTile(pass, "claude"),
        (pass) => {
          title = find(pass.view, (el) => el.props.title === lock.title)?.props.title;
          expect(action(pass)).toBeDefined();
        },
      ],
    });
    expect(title).toBe(lock.title);
  });
});
