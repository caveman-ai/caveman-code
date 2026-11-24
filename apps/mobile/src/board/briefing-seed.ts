// What the scripted world adds so a first launch (or `?fresh`) comes back to a briefing (store/away.ts): you left the
// app six and a half hours ago, and since then the world's own changes landed (two merges and the chats ready to try,
// in world.ts) plus what is here: a third merge, and three things the Chiefs decided on their own, said in their chats
// as they did them. The failed run comes from the automations' own history (screens/pages/automations-model.ts). The
// fresh store adds it to the world (store/store.ts freshState, `withBriefingSeed`), so the world's own tests and
// counts stay as they are.
import { type Chat, itemId, type Said } from "./model";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/** How long ago the scripted morning says you left the app. */
export const AWAY_SEED_MS = 6 * HOUR + 30 * MINUTE;

/** The chats and Chief lines the briefing seed adds to the world, around `now`. */
export function briefingSeed(now: number): { chats: Chat[]; decided: Omit<Said, "id">[] } {
  const ago = (ms: number) => now - ms;
  const usageCsv: Chat = {
    id: "usage-csv",
    title: "Usage export to CSV",
    repo: "Caveman Cloud",
    device: "cloud",
    chief: "grug",
    engine: "codex",
    model: "GPT-5.5",
    phase: "done",
    line: "Merged #607",
    startedAt: ago(2 * HOUR + 40 * MINUTE),
    updatedAt: ago(70 * MINUTE),
    items: [
      { kind: "you", id: itemId(), text: "Let people export their usage as CSV from the usage page: one row per day per model.", at: ago(2 * HOUR + 40 * MINUTE) },
      {
        kind: "work",
        id: itemId(),
        steps: [
          { tool: "read", text: "Read usage/page.tsx", detail: "188 lines" },
          { tool: "edit", text: "Created usage/export.ts", detail: "+64" },
          { tool: "run", text: "Ran the usage tests", detail: "pnpm test usage  12/12 passed" },
        ],
        startedAt: ago(2 * HOUR + 40 * MINUTE),
        endedAt: ago(2 * HOUR + 5 * MINUTE),
      },
      {
        kind: "text",
        id: itemId(),
        text: "Merged **#607**. The usage page has an Export button now: a CSV with one row per day per model, in the account's time zone. All **12 usage tests** pass.",
        at: ago(70 * MINUTE),
        phase: "final",
      },
    ],
  };
  return {
    chats: [usageCsv],
    decided: [
      { chief: "home", who: "chief", text: "Merged [[rail]] once CI went green. You approved the design yesterday, so I didn't wait.", at: ago(164 * MINUTE), decided: true },
      { chief: "grug", who: "chief", text: "Merged [[usage-csv]] on my own once its checks passed: it only adds a download, nothing reads it yet.", at: ago(69 * MINUTE), decided: true },
      { chief: "grug", who: "chief", text: "Put [[relay]] in Cloud instead of on Studio: the soak needs Linux, and 50 runs instead of 10, since it fails about once in twenty.", at: ago(22 * MINUTE), decided: true },
    ],
  };
}

/**
 * The world's chats and lines with the seed's added, each once (a world that already carries them keeps its own), the
 * lines in the order they were said, numbered after the world's.
 */
export function withBriefingSeed(chats: readonly Chat[], said: readonly Said[], now: number): { chats: Chat[]; said: Said[] } {
  const seed = briefingSeed(now);
  const have = new Set(chats.map((c) => c.id));
  const next = said.reduce((n, l) => Math.max(n, l.id + 1), 1);
  const spoken = new Set(said.map((l) => `${l.chief}\n${l.text}`));
  const lines = seed.decided.filter((l) => !spoken.has(`${l.chief}\n${l.text}`)).map((l, i): Said => ({ ...l, id: next + i }));
  return { chats: [...chats, ...seed.chats.filter((c) => !have.has(c.id))], said: [...said, ...lines].sort((a, b) => a.at - b.at) };
}
