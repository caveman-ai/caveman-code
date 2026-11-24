// The chat box mounted with React DOM: what a keystroke in it sends, and what it shows when it shows again.
import { document, fire } from "../testing/dom.ts";
import { Activity, act, createElement, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { afterEach, expect, test, vi } from "vitest";
import { TooltipProvider } from "@caveman-app/ui/components/tooltip";

// The mic and the voice engine are faked; the dictation store (stopDictation, its shared wait) is the real one. The
// last words land when the test says so (up to FLUSH_MS, 2 s, in a browser).
const voice = vi.hoisted(() => ({ settle: (): void => undefined }));
vi.mock("../call/media.ts", async (real) => ({
  ...(await real<typeof import("../call/media.ts")>()),
  microphone: vi.fn(async () => ({ getTracks: () => [] })),
  openCapture: vi.fn(async () => ({ onFrame: null, level: () => 0, close: () => undefined })),
}));
vi.mock("../call/engine.ts", async (real) => ({
  ...(await real<typeof import("../call/engine.ts")>()),
  openDictation: vi.fn(() => ({
    sentMs: 0,
    close: () => undefined,
    finish: () => new Promise<void>((resolve) => (voice.settle = resolve)),
  })),
}));

import { RuntimeFixture, type RuntimeContextValue } from "../state/runtime.tsx";
import { keepDraft, keepFiles, keptDraft, keptFiles } from "../state/composer-drafts.ts";
import { dictationState, startDictation } from "../dictation/store.ts";
import { Composer } from "./Composer.tsx";

const client = {
  on: () => () => undefined,
  onStatus: () => () => undefined,
  call: vi.fn(async (method: string) =>
    method === "dictation.start"
      ? {
          dictation_id: "d1",
          connect: {
            transport: "websocket",
            url: "wss://voice.test",
            protocols: [],
            input_rate: 16_000,
          },
        }
      : {},
  ),
};
const runtime = {
  status: "open",
  error: null,
  client,
  identity: { kind: "local" },
  workspaces: [],
  raw: new Map(),
  projects: [],
  engines: [],
  settings: null,
  refresh: async () => undefined,
  connection: 1,
  markSeen: () => undefined,
} as unknown as RuntimeContextValue;

const unmounts: Array<() => void> = [];
afterEach(() => unmounts.splice(0).forEach((u) => u()));

type Props = Record<string, unknown>;
const box = (props: Props) =>
  createElement(Composer, {
    running: false,
    engineLabel: "Claude Agent",
    canSteer: false,
    onInterrupt: async () => undefined,
    onSubmit: async () => undefined,
    ...props,
  } as never);

async function mount(content: ReactNode) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  const render = (next: ReactNode) =>
    act(async () =>
      root.render(
        createElement(
          TooltipProvider,
          null,
          createElement(
            MemoryRouter,
            null,
            createElement(RuntimeFixture, { value: runtime, children: next }),
          ),
        ),
      ),
    );
  await render(content);
  unmounts.push(() => {
    act(() => root.unmount());
    host.remove();
  });
  // The box on screen: a box kept hidden sits under display: none.
  const textarea = () =>
    [...host.querySelectorAll("textarea")].find((t) => !t.closest("[style*='display: none']"))!;
  const enter = (fields: Record<string, unknown> = {}) =>
    act(
      async () =>
        void fire(textarea(), "keydown", {
          key: "Enter",
          code: "Enter",
          keyCode: 13,
          isComposing: false,
          shiftKey: false,
          altKey: false,
          metaKey: false,
          ctrlKey: false,
          ...fields,
        }),
    );
  return { host, render, textarea, enter };
}

test("an Enter that commits an IME candidate does not send, in Safari's form (keyCode 229) as in Chrome's (isComposing)", async () => {
  const sent: string[] = [];
  keepDraft("chat:ime", { text: "にほんご", refs: [] });
  const b = await mount(
    box({ draftKey: "chat:ime", onSubmit: async (text: string) => void sent.push(text) }),
  );
  expect(b.textarea().value).toBe("にほんご");
  // Chrome: keydown while composing says so.
  await b.enter({ keyCode: 229, isComposing: true });
  expect(sent).toEqual([]);
  // WebKit fires compositionend first, then the committing keydown with keyCode 229 and isComposing false.
  await b.enter({ keyCode: 229, isComposing: false });
  expect(sent, "sent by Safari's committing Enter").toEqual([]);
  // The Enter after it sends.
  await b.enter();
  expect(sent).toEqual(["にほんご"]);
});

/** A box with `typed` settled in it (and `files` attached), its mic live. */
async function listening(draftKey: string, props: Props, typed: string, files: unknown[] = []) {
  keepDraft(draftKey, { text: typed, refs: [] });
  keepFiles(draftKey, files);
  const b = await mount(box({ draftKey, ...props }));
  await act(async () =>
    startDictation(client as never, { owner: draftKey, onFinal: () => undefined }),
  );
  expect(dictationState().phase).toBe("live");
  return {
    ...b,
    // The last words land; every send waiting on them goes on.
    settle: () =>
      act(async () => {
        voice.settle();
        await new Promise((r) => setTimeout(r, 10));
      }),
  };
}

test("Enter pressed again while the last spoken words land sends the Chief one capture, not two", async () => {
  const captures: string[] = [];
  const b = await listening(
    "chief",
    {
      engineLabel: "Chief",
      compact: true,
      onCapture: async (text: string) => void captures.push(text),
    },
    "ship the auth fix",
  );
  await b.enter();
  expect(dictationState().phase).toBe("finishing");
  // Nothing shows yet while the words land: the person presses Enter again.
  await b.enter();
  await b.settle();
  expect(dictationState().phase).toBe("idle");
  expect(captures).toEqual(["ship the auth fix"]);
});

test("Enter pressed again while the last spoken words land sends a chat one turn with its image, not a second empty one", async () => {
  const image = {
    attachment: { type: "image", name: "shot.png", mime_type: "image/png", data: "iVBORw0KGgo=" },
    url: "data:image/png;base64,iVBORw0KGgo=",
    size: 8,
  };
  const turns: Array<{ text: string; files: string[] }> = [];
  const onSubmit = async (
    text: string,
    _kind: string,
    _choice: unknown,
    attachments: Array<{ name: string }>,
  ) => void turns.push({ text, files: attachments.map((a) => a.name) });
  const b = await listening("chat:voice", { onSubmit }, "look at this", [image]);
  await b.enter();
  expect(dictationState().phase).toBe("finishing");
  await b.enter();
  await b.settle();
  expect(turns).toEqual([{ text: "look at this", files: ["shot.png"] }]);
});

test("a box kept hidden shows its chat's draft as it is now when it shows again, not a message sent from another box since", async () => {
  const image = {
    attachment: { type: "image", name: "plan.png", mime_type: "image/png", data: "iVBORw0KGgo=" },
    url: "data:image/png;base64,iVBORw0KGgo=",
    size: 8,
  };
  const sent: Array<{ text: string; files: string[] }> = [];
  const onSubmit = async (
    text: string,
    _kind: string,
    _choice: unknown,
    attachments: Array<{ name: string }>,
  ) => void sent.push({ text, files: attachments.map((a) => a.name) });
  keepDraft("chat:A", { text: "run the migration", refs: [] });
  keepFiles("chat:A", [image]);
  // A pane shows chat A (PaneFrame keeps a chat it showed lately rendered, hidden, behind Activity).
  const pane = (shown: boolean) =>
    createElement(Activity, {
      mode: shown ? "visible" : "hidden",
      children: box({ draftKey: "chat:A", onSubmit }),
    });
  const one = await mount(pane(true));
  expect(one.textarea().value).toBe("run the migration");
  // The pane moves to another chat and back: A, kept rendered there while hidden, shows what it held.
  await one.render(pane(false));
  await one.render(pane(true));
  expect(one.textarea().value).toBe("run the migration");
  await one.render(pane(false));
  // A opens in a tab of its own: a box of its own for the same chat, which sends the draft.
  const two = await mount(box({ draftKey: "chat:A", onSubmit }));
  expect(two.textarea().value).toBe("run the migration");
  await two.enter();
  expect(sent).toEqual([{ text: "run the migration", files: ["plan.png"] }]);
  expect(keptDraft("chat:A")).toBeNull();
  unmounts.pop()!();
  // Back in the first pane, A shows again: its box holds what the chat holds now, and Enter sends nothing.
  await one.render(pane(true));
  expect(one.textarea().value).toBe("");
  expect(one.host.querySelector('img[alt="plan.png"]')).toBeNull();
  expect(keptFiles("chat:A")).toEqual([]);
  await one.enter();
  expect(sent).toHaveLength(1);
  expect(keptDraft("chat:A")).toBeNull();
  expect(keptFiles("chat:A")).toEqual([]);
});
