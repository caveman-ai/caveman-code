// The Live Activity's life and the widget's content, kept in step with the store and the conversation out loud
// (talk.ts) for as long as the app runs (docs/).
//
// - The Live Activity is up while anything is at work, waits on you, or you're talking to a Chief or in voice chat.
//   iOS starts one only while the app is in front, so it starts there and is updated from then on, also from the
//   background while a call keeps the app running. With nothing left it ends on what is left (ready to try, or all
//   done), which stays on the Lock Screen a little while. Each update marks it stale 15 minutes on, and the app renews
//   that while it runs, so a suspended app's activity reads "Out of date" instead of claiming work goes on.
// - Its buttons that stop or hold things (Deny, Mute, End) run as iOS 17 Live Activity intents in this process,
//   waking it if it sleeps, and arrive here as interactions. Those that let an agent go ahead (Allow, a question's
//   options) open the app on a link instead, which a locked phone unlocks first, and are answered here behind Undo.
// - The widget gets a snapshot when what it says changes.
//
// Only on an iPhone with the widget extension built in (a development or store build). In Expo Go and on the web the
// native module is missing and all of this is off.
import { requireOptionalNativeModule } from "expo";
import { AppState, Linking, Platform } from "react-native";
import { act, no } from "../asks/decide";
import { store } from "../store/store";
import { Activity, GlanceWidget } from "../widgets/layouts";
import { faceOf } from "./faces";
import { activityKey, type Glance, glanceOf, isLive, widgetKey } from "./glance";
import { endTalk, muteTalk, type Talk, talkStore } from "./talk";

type Widgets = typeof import("expo-widgets");
type LiveActivity = import("expo-widgets").LiveActivity<Glance>;

/** No news for this long and the activity reads "Out of date". */
const STALE_MS = 15 * 60_000;
/** While the app runs it vouches for the activity again this often. */
const RENEW_MS = 5 * 60_000;
/** Words that change every few seconds (a working chat's live line) reach the Lock Screen at most this often. */
const LINE_MS = 6_000;
/** The widget's words at most this often; its mood and counts at once. */
const WIDGET_MS = 20_000;
/** How long what it ended on stays on the Lock Screen. */
const DONE_MS = 20 * 60_000;
/** ActivityKit takes 4 KB of content: the line is cut well inside it. */
const LINE_MAX = 160;

function widgets(): Widgets | null {
  if (Platform.OS !== "ios" || !requireOptionalNativeModule("ExpoWidgets")) return null;
  try {
    return require("expo-widgets") as Widgets;
  } catch {
    return null;
  }
}

/**
 * The answer a Lock Screen link carries (glance.ts answerLink: caveman://chat/<id>?answer=allow|<option>), given here
 * once the app is open and unlocked, behind the toast's Undo as any answer in the app is. False when it carries none.
 */
export function answerFrom(url: string | null | undefined): boolean {
  const m = url?.match(/^caveman:\/\/chat\/([^/?#]+)\?(?:.*&)?answer=([^&#]+)/);
  if (!m) return false;
  const id = decodeURIComponent(m[1]!);
  const answer = decodeURIComponent(m[2]!);
  if (answer === "allow") return act(id, { kind: "allow" });
  const need = store.get().board.chats.find((c) => c.id === id)?.need;
  const option = need?.kind === "question" ? need.options[Number(answer)] : undefined;
  return option ? act(id, { kind: "option", option }) : false;
}

let started = false;

export function startActivity() {
  if (started) return;
  started = true;
  const kit = widgets();
  if (!kit) return;

  const faces: Record<string, string> = {};
  /** The glance with the conversation out loud (the Live Activity's) or without it (the widget's). */
  const glance = (talk: Talk | null): Glance => {
    const g = glanceOf(store.get(), talk);
    const face = faces[g.chief];
    if (face === undefined && g.chief && kit.widgetsDirectory) {
      faces[g.chief] = "";
      void faceOf(kit.widgetsDirectory, g.chief).then((uri) => {
        faces[g.chief] = uri;
        if (uri) sync();
      });
    }
    return { ...g, face: face ?? "" };
  };

  const factory = kit.createLiveActivity<Glance>("Activity", Activity);
  // What the widget shows before the app has said anything (the gallery, a fresh install): how things stand now.
  const widget = kit.createWidget<Glance>("Glance", GlanceWidget, glance(null));

  // An activity from before a relaunch is ours to keep updating; any extra ones are ended.
  const [kept, ...extra] = factory.getInstances();
  let live: LiveActivity | null = kept ?? null;
  for (const old of extra) void old.end("immediate");
  /** The one that ended and still shows what it ended on; a new one replaces it at once. */
  let lingering: LiveActivity | null = null;

  let shown = "";
  let shownMood = "";
  let lastUpdate = 0;
  let pending: ReturnType<typeof setTimeout> | null = null;
  let widgetShown = "";
  let widgetCounts = "";
  let widgetAt = 0;
  let widgetLater: ReturnType<typeof setTimeout> | null = null;

  const staleDate = () => new Date(Date.now() + STALE_MS);
  /** What the activity carries: no list (only the widget draws one), the line cut short. */
  const payload = (g: Glance): Glance => ({ ...g, rows: [], line: g.line.length > LINE_MAX ? `${g.line.slice(0, LINE_MAX - 1)}…` : g.line });

  const push = (g: Glance) => {
    shown = activityKey(g);
    shownMood = g.mood;
    lastUpdate = Date.now();
    const now = live;
    if (now) {
      void now.update(payload(g), staleDate()).catch(() => {
        // It's gone (dismissed from the Lock Screen): the next change while in front starts another.
        if (live === now) live = null;
      });
      return;
    }
    // Only an app in front may start one; the next change while it is in front will.
    if (AppState.currentState !== "active") return;
    try {
      if (lingering) void lingering.end("immediate").catch(() => undefined);
      lingering = null;
      // No URL of its own: the layout sets each presentation's tap from what it says now.
      live = factory.start(payload(g), undefined, staleDate());
    } catch {
      live = null;
    }
  };

  const finish = (g: Glance) => {
    const was = live;
    live = null;
    shown = "";
    shownMood = "";
    if (!was) return;
    lingering = was;
    void was.end(kit.after(new Date(Date.now() + DONE_MS)), payload(g)).catch(() => undefined);
  };

  /** The widget: at once when its mood or counts change, else when its words do, at most every WIDGET_MS. */
  const syncWidget = () => {
    const w = glance(null);
    const key = widgetKey(w);
    if (key === widgetShown) return;
    const counts = [w.mood, w.needs, w.ready, w.working].join();
    const wait = WIDGET_MS - (Date.now() - widgetAt);
    if (counts === widgetCounts && wait > 0) {
      // Words only: they go in a little while, even if nothing else changes by then.
      widgetLater ??= setTimeout(() => {
        widgetLater = null;
        syncWidget();
      }, wait);
      return;
    }
    if (widgetLater) clearTimeout(widgetLater);
    widgetLater = null;
    widgetShown = key;
    widgetCounts = counts;
    widgetAt = Date.now();
    try {
      widget.updateSnapshot(w);
    } catch {
      // The extension isn't there (a build without it): the app goes on without its widget.
    }
  };

  function sync() {
    syncWidget();
    const g = glance(talkStore.get());
    if (!isLive(g)) {
      if (live) finish(g);
      return;
    }
    const key = activityKey(g);
    if (key === shown && live) return;
    // A new mood, a new ask or a call's change shows at once; a working line waits its turn.
    const now = Date.now();
    const urgent = g.mood !== shownMood || g.mood === "talk" || g.mood === "needs" || !live;
    if (urgent || now - lastUpdate >= LINE_MS) {
      if (pending) clearTimeout(pending);
      pending = null;
      push(g);
    } else if (!pending) {
      pending = setTimeout(() => {
        pending = null;
        sync();
      }, LINE_MS - (now - lastUpdate));
    }
  }

  /** Vouches for what it says again: a fresh stale date, even when nothing changed. */
  const renew = () => {
    shown = "";
    sync();
  };

  store.subscribe(sync);
  talkStore.watch(() => sync());
  setInterval(renew, RENEW_MS);
  // Coming to the front is when one can start, and when an "Out of date" one is current again.
  AppState.addEventListener("change", (state) => {
    if (state === "active") renew();
  });

  // Deny, Mute and End on the Lock Screen and in the Dynamic Island, in place.
  kit.addUserInteractionListener((event) => {
    const [what, id] = event.target.split(":");
    if (what === "deny" && id) no(id);
    else if (what === "mute") muteTalk();
    else if (what === "end") endTalk();
    sync();
  });

  // Allow and a question's options open the app on a link that carries the answer: at launch, or while it runs.
  void Linking.getInitialURL().then(answerFrom);
  Linking.addEventListener("url", ({ url }) => void answerFrom(url));

  sync();
}
