// Holding the app icon: New chat, Call the Chief, Voice chat, then the last chat you opened. The first three exist
// before the app's first launch (app.json, expo-quick-actions' `iosActions`); once it runs, the app keeps the list
// current: the first Chief by its own name, and the last chat. A pick opens the app there, cold or not.
import { requireOptionalNativeModule } from "expo";
import { Platform } from "react-native";
import { CHIEFS } from "../board/model";
import { navigationRef, openChat, openChief, showNewChat } from "../nav/ref";
import { startVoice } from "../shell/composer/voice";
import { ui } from "../shell/ui";
import { store } from "../store/store";

type QuickActions = typeof import("expo-quick-actions");
type Action = import("expo-quick-actions").Action;

function quickActions(): QuickActions | null {
  if (Platform.OS === "web" || !requireOptionalNativeModule("ExpoQuickActions")) return null;
  try {
    return require("expo-quick-actions") as QuickActions;
  } catch {
    return null;
  }
}

/** Where a shortcut goes, by the `href` it carries (also the static ones in app.json). Anything else goes nowhere. */
export function follow(href: unknown) {
  if (typeof href !== "string") return;
  const chief = href.match(/^caveman:\/\/chief\/([^/?#]+)\?call=1$/);
  const chat = href.match(/^caveman:\/\/chat\/([^/?#]+)$/);
  if (href === "caveman://new") showNewChat();
  else if (href === "caveman://new?voice=1") {
    showNewChat();
    startVoice();
  } else if (chief) openChief(decodeURIComponent(chief[1]!), { call: Date.now() });
  else if (chat && store.get().board.chats.some((c) => c.id === decodeURIComponent(chat[1]!))) openChat(decodeURIComponent(chat[1]!));
}

/** Runs once the navigator can take it: a cold start's shortcut arrives before the first screen is up. */
function whenReady(run: () => void, tries = 50) {
  if (navigationRef.isReady()) run();
  else if (tries > 0) setTimeout(() => whenReady(run, tries - 1), 100);
}

export function itemsFor(last: { id: string; title: string } | null): Action[] {
  const chief = CHIEFS[0];
  const items: Action[] = [{ id: "new", title: "New chat", icon: "symbol:square.and.pencil", params: { href: "caveman://new" } }];
  if (chief) items.push({ id: "call", title: chief.name === "Chief" ? "Call the Chief" : `Call ${chief.name}`, icon: "symbol:phone.fill", params: { href: `caveman://chief/${encodeURIComponent(chief.id)}?call=1` } });
  items.push({ id: "voice", title: "Voice chat", icon: "symbol:waveform", params: { href: "caveman://new?voice=1" } });
  if (last) items.push({ id: "last", title: last.title, subtitle: "Last chat", icon: "symbol:bubble.left", params: { href: `caveman://chat/${encodeURIComponent(last.id)}` } });
  return items;
}

let started = false;

export function startShortcuts() {
  if (started) return;
  started = true;
  const kit = quickActions();
  if (!kit) return;

  if (kit.initial) {
    const href = kit.initial.params?.href;
    whenReady(() => follow(href));
  }
  kit.addListener((action) => whenReady(() => follow(action.params?.href)));

  // The list follows the last chat you had open, and the first Chief's name.
  let shown = "";
  let last: { id: string; title: string } | null = null;
  const sync = () => {
    const focused = ui.get().focused;
    if (focused?.name === "Thread" && focused.id) {
      const chat = store.get().board.chats.find((c) => c.id === focused.id);
      if (chat && !chat.parent) last = { id: chat.id, title: chat.title };
    }
    const items = itemsFor(last);
    const key = JSON.stringify(items);
    if (key === shown) return;
    shown = key;
    void kit.setItems(items).catch(() => undefined);
  };
  ui.subscribe(sync);
  sync();
}
