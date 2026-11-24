// The notch in a browser, on fixture chats: notch.html?demo=<rest|working|finished|approve|answer|failed|stack|many>
// (stack: the four that wait at once, its arrows paging between them), with &open to hold it open, &trouble for a
// press that did not go through, &alert to have the chat come to wait a moment after the page loads (the notch opens
// by itself, holds, and folds back), and &plain for a display with no notch of its own. The stand-in desktop behind
// it is this page's alone; the app's notch has none.
import type { ChatStatus, ChatStatusId } from "../state/model.ts";
import type { NotchAgent, NotchCard, NotchState } from "./model.ts";
import type { NotchBridge } from "./Notch.tsx";

const status = (id: ChatStatusId, label: string, more: Partial<ChatStatus> = {}): ChatStatus => ({
  id,
  label,
  detail: null,
  action: false,
  since: null,
  progress: null,
  agents: 0,
  ...more,
});
const minutesAgo = (n: number) => new Date(Date.now() - n * 60_000).toISOString();

const working = (id: string, title: string, more: Partial<ChatStatus> = {}): NotchAgent => ({
  id,
  title,
  status: status("working", "Working", { since: minutesAgo(4), ...more }),
});
const AT_WORK: NotchAgent[] = [
  working("w1", "Port the theme page", { progress: { done: 3, total: 5 } }),
  working("w2", "Fix the flaky relay test", { since: minutesAgo(12) }),
  {
    id: "w3",
    title: "Review the billing migration",
    status: status("agents", "Waiting on agents", { agents: 3 }),
  },
];

/** A stand-in screenshot: a settings page in the deck's colours, as the data URL a chat's proof arrives as. */
const SHOT = `data:image/svg+xml,${encodeURIComponent(
  `<svg xmlns="http://www.w3.org/2000/svg" width="608" height="380" viewBox="0 0 608 380"><rect width="608" height="380" fill="#121213"/><rect width="150" height="380" fill="#0b0b0c"/><rect x="16" y="20" width="84" height="10" rx="5" fill="#3a3a3f"/>${[
    0, 1, 2, 3, 4,
  ]
    .map(
      (i) =>
        `<rect x="16" y="${58 + i * 28}" width="${[96, 72, 104, 64, 88][i]}" height="8" rx="4" fill="${i === 1 ? "#e4e4e7" : "#2a2a2e"}"/>`,
    )
    .join(
      "",
    )}<rect x="182" y="24" width="150" height="14" rx="7" fill="#e4e4e7"/><rect x="182" y="50" width="260" height="8" rx="4" fill="#3a3a3f"/>${[
    0, 1, 2,
  ]
    .map(
      (i) =>
        `<rect x="182" y="${88 + i * 84}" width="394" height="68" rx="10" fill="#19191b" stroke="#26262a"/><rect x="198" y="${106 + i * 84}" width="${[120, 150, 96][i]}" height="9" rx="4.5" fill="#d4d4d8"/><rect x="198" y="${126 + i * 84}" width="${[210, 180, 230][i]}" height="7" rx="3.5" fill="#3a3a3f"/><rect x="520" y="${112 + i * 84}" width="40" height="20" rx="10" fill="${i === 0 ? "#e4e4e7" : "#2a2a2e"}"/>`,
    )
    .join("")}</svg>`,
)}`;

const card = (id: string, title: string, s: ChatStatus, more: Partial<NotchCard>): NotchCard => ({
  id,
  title,
  status: s,
  line: null,
  command: null,
  image: null,
  keys: [],
  ask: null,
  trouble: null,
  index: 0,
  count: 1,
  prev: null,
  next: null,
  ...more,
});

const CARDS: Record<string, NotchCard> = {
  finished: card("c1", "Redesign the settings page", status("done", "Finished"), {
    line: "4 files · The settings page is rebuilt on the list layout, with the new switches.",
    image: SHOT,
    keys: [
      { id: "ship", label: "Ship it", tone: "lit" },
      { id: "later", label: "Later", tone: "card" },
    ],
  }),
  approve: card("c2", "Clean up the build cache", status("approve", "Approve", { action: true }), {
    line: "Allow this command?",
    command: "rm -rf apps/web/dist packages/runtime/dist",
    keys: [
      { id: "ask\ta1\t0", label: "Allow", tone: "lit" },
      { id: "ask\ta1\t1", label: "Always allow", tone: "card" },
      { id: "ask\ta1\t2", label: "Deny", tone: "card" },
    ],
  }),
  answer: card("c3", "Add sign in with GitHub", status("answer", "Answer", { action: true }), {
    line: "Where should the sign-in callback live in production?",
    keys: [
      { id: "ask\ta3\t0", label: "api.caveman.so", tone: "lit" },
      { id: "ask\ta3\t1", label: "app.caveman.so", tone: "card" },
    ],
  }),
  failed: card("c4", "Upgrade to Effect 4", status("failed", "Failed"), {
    line: "Failed · The type checker still reports 12 errors in packages/runtime.",
    keys: [
      { id: "seen", label: "Done", tone: "lit" },
      { id: "later", label: "Later", tone: "card" },
    ],
  }),
};

/** Every card at once, the one named `id` showing, as the app pages the card when its arrows ask. */
function stack(id: string): NotchState {
  const all = Object.values(CARDS);
  const index = Math.max(
    0,
    all.findIndex((c) => c.id === id),
  );
  return {
    agents: [...all.map((c) => ({ id: c.id, title: c.title, status: c.status })), ...AT_WORK],
    card: {
      ...all[index]!,
      index,
      count: all.length,
      prev: all[index - 1]?.id ?? null,
      next: all[index + 1]?.id ?? null,
    },
    unseen: all.map((c) => `${c.id}:1`),
  };
}

function fixture(name: string): NotchState {
  if (name === "stack") return stack("c1");
  const waiting = CARDS[name];
  if (waiting)
    return {
      agents: [
        { id: waiting.id, title: waiting.title, status: waiting.status },
        ...AT_WORK.slice(0, 2),
      ],
      card: waiting,
      unseen: [`${waiting.id}:1`],
    };
  if (name === "working") return { agents: AT_WORK, card: null, unseen: [] };
  if (name === "many")
    return {
      agents: Array.from({ length: 11 }, (_, i) =>
        working(`m${i}`, `Chat number ${i + 1}`, { since: minutesAgo(i + 1) }),
      ),
      card: null,
      unseen: [],
    };
  return { agents: [], card: null, unseen: [] };
}

/** A 440x560 window against the top of a stand-in desktop with a menu bar, as apps/desktop src/notch.ts makes it. */
function stage(bar: number): void {
  document.body.style.cssText =
    "background: linear-gradient(135deg, #2e6f8e, #89b7c9 45%, #d9a066 80%, #b5532f) !important";
  const menu = document.createElement("div");
  menu.style.cssText = `position: fixed; inset: 0 0 auto; height: ${bar}px; background: hsl(0 0% 100% / 0.28); backdrop-filter: blur(20px)`;
  document.body.prepend(menu);
  document.getElementById("root")!.style.cssText =
    "position: fixed; top: 0; left: calc(50% - 220px); width: 440px; height: 560px";
}

export function demo(query: URLSearchParams): [NotchBridge, boolean] {
  // &plain: a display with no notch of its own (an external one): the island is a pill in a plain menu bar.
  const hardware = query.has("plain") ? null : { width: 185, height: 32 };
  const bar = hardware ? 33 : 25;
  stage(bar);
  const shown = fixture(query.get("demo") ?? "rest");
  // &trouble: the card's last press did not go through.
  const state =
    query.has("trouble") && shown.card
      ? {
          ...shown,
          card: {
            ...shown.card,
            trouble: { text: "Not connected to this chat's computer.", n: 1 },
          },
        }
      : shown;
  let tell: ((feed: { state: NotchState; hardware: typeof hardware; bar: number }) => void) | null =
    null;
  const bridge: NotchBridge = {
    onState: (handler) => {
      tell = handler;
      // Came to wait a moment after the page showed what was there: the notch opens by itself.
      if (query.has("alert")) {
        handler({ state: { ...state, card: null, unseen: [] }, hardware, bar });
        setTimeout(() => handler({ state, hardware, bar }), 1_200);
      } else handler({ state, hardware, bar });
    },
    onAway: () => undefined,
    act: (action) => {
      console.log("notch:", action);
      if (action.type === "show") tell?.({ state: stack(action.id), hardware, bar });
    },
    over: () => undefined,
    menu: () => undefined,
  };
  return [bridge, query.has("open")];
}
