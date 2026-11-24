// Chords the app keeps for itself, outside Settings > Keyboard's list: keybindings.set refuses them, so a
// rebound command never silently takes one from the composer, the text you type or the desktop menu.
import * as Keybindings from "../keybindings.ts";

const OWN: ReadonlyArray<readonly [string, string]> = [
  ...Array.from({ length: 9 }, (_, i) => [`mod+${i + 1}`, i === 8 ? "goes to the last tab" : `goes to tab ${i + 1}`] as const),
  ["enter", "sends a message"],
  ["shift+enter", "adds a new line"],
  ["mod+enter", "sends or starts now"],
  ["alt+enter", "queues a message"],
  // With "Send with ⌘Enter" on, the composer and the Chief move their keys up one modifier.
  ["mod+alt+enter", "queues a message"],
  ["mod+shift+enter", "starts a Chief note now"],
  ["mod+n", "starts a new chat"],
  ["mod+,", "opens Settings"],
  ["mod+w", "closes a tab or the window"],
  ["mod+c", "copies"],
  ["mod+v", "pastes"],
  ["mod+x", "cuts"],
  ["mod+a", "selects all"],
  ["mod+z", "undoes"],
  ["mod+shift+z", "redoes"],
];

const canonical = (key: string) => {
  const parsed = Keybindings.parseKeybindingShortcut(key);
  return parsed === null ? null : Keybindings.encodeShortcut(parsed);
};

const RESERVED = new Map(OWN.flatMap(([key, what]) => {
  const at = canonical(key);
  return at === null ? [] : [[at, what] as const];
}));

/** What the app does with this canonical chord, when it keeps it for itself; undefined when it is free. */
export function reservedChord(key: string): string | undefined {
  return RESERVED.get(key);
}
