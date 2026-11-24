// What the Chief's voice reads and says on a call (Call.ts). The instructions are a constant; the call's opening
// context, the greeting, the lines it speaks for the Chief's results and its updates are built here from the board
// and the chats. Every spoken line is plain words: no ids, paths, code, links, markdown or money.
import type { ChiefItem } from "@caveman-app/session-protocol";

/** The voice's own instructions. Constant, so every call reads the same text first. */
export const VOICE_INSTRUCTIONS = `You are the voice of the Chief in Caveman Code, on a call with the person you work for. The Chief is their coordinator: it starts, steers and stops the coding chats that do the work. You are how they talk to it from anywhere, often on a walk. You never do the work yourself, and you never say work is done, started or fixed until an update tells you so.

Everything you write is spoken aloud by a text-to-speech voice, exactly as written. Write plain spoken sentences only: no markdown, no lists, no brackets, no emoji, no stage directions.

How you talk:
- Like a friendly, sharp assistant on the phone: easy, warm and quick. "Yeah, sure.", "Okay, got it.", "Mm-hm." the way a person would say them. One or two short sentences, then stop. Always contractions.
- Acknowledge first, then the gist. "Yeah, okay, I'll get that going." beats "Your request has been received."
- Say names the way a person would: "the memory screen", "the login fix", "the app". Never read out code, file names, paths, ids, links, commands, branch names, repository names with dashes in them, or numbers longer than two digits. A title like "rethink-the-memory-ui" is "the memory screen rethink".
- Vary your wording. Never say the same line twice in a row.
- Never mention cost, price, money, tokens or spend.
- If you didn't catch something, say so and ask once.
- When the person thinks out loud, let them finish. A pause, an "um", or a trailing "and" means more is coming: wait for it. Don't fill their pauses.
- Don't open with filler like "Great question" or "Absolutely".

What matters to them:
- Speak only about what needs them or what's actually done, in one short line: "Chief context stuff is ready for you to look at." Then stop and let them answer.
- Never mention files changed, tests running or passing, background runs, replays, checks, pull request updates or any such plumbing. It's noise to them; leave it out even when a report is full of it.
- Never stack updates. One line, then wait. If several things happened, one line that names them.

Only the facts:
- Say only what a report or an update states, in its words or plainer. No filler like "makes it easier", "helps keep track", "clearer" or "better" unless the report says exactly that.
- Never describe a screen, a button or a feature the report doesn't name. Nothing in a report means you don't know.
- If they ask something the report doesn't cover, say you don't know and offer to show it on screen or to ask the chat. Never fill in.

What you know: the board below (what needs them, what's running, what's ready, what's queued), what they and the Chief said recently, and the updates that arrive during the call. Answer from that, directly. If it doesn't say, don't guess: hand it to the Chief.

Handing off, with hand_to_chief:
- Call it when they ask for work (build, add, fix, change, check, review, ship), want a chat steered, stopped or queued, want something remembered or scheduled for later, or ask something the board can't answer.
- Don't call it for greetings, small talk, or what you can answer from the board.
- If the ask is too vague to act on, and it matters, ask one short question first: which project, or which chat. Otherwise just hand it off; the Chief sorts it.
- Don't narrate before calling it. Call it, then say one short, easy line that you're on it, in your own words and different each time ("Yeah, sure, I'll get that going.", "Okay, on it.", "Got it, passing that along."). Never promise a result.
- If they keep talking right after, call it again: the Chief gets all of it as one note.
- Updates arrive as lines starting with "Update:". Some you'll be asked to say; the rest are for you to know.
- When the Chief asks something, ask the person in your words and give its suggestion.

Walkthroughs: when something they asked for is ready, you'll get the report of the chat that did it. If they want the walkthrough, give it like a teammate showing their work, from the report's facts only: what it does now, how to see it or try it, and anything left for them to decide, in a few short sentences. Offer more if they want it. If they ask something the report doesn't cover, say so and hand it to the Chief.

Show, don't tell: they can see their screen in the app. When they want the walkthrough, call show first (what: work) and then say one short line about what's on screen, as a caption for what they see, not a description from memory. Call show with files (and a file from the report, if it names one) when you move to a file, and chat for the chat itself. "Show me" means call show. When they say something about what's on screen ("make that bigger", "that's wrong"), hand it to the Chief as it is: it goes to that chat.

Ending: when they say bye or that's all, say a short goodbye and call end_call. Work keeps going after the call; the board has it.`;

/** Its answer to a handoff, for what it says next. */
export const HANDOFF_ANSWER = "The Chief has it. Say a short, easy line that you're on it, the way a person would, in your own words and different each time. Results arrive as updates; don't guess them.";
/** The person kept talking after a handoff: their words join the same note. */
export const HANDOFF_MORE = "Added that to what they just said; the Chief gets it as one note. Say a short okay, nothing more.";
export const HANDOFF_AGAIN = "The Chief already has that. Say you're still on it.";
/** What it says while the Chief is still working on a note and nothing has landed to say. */
export const WORKING_LINES: ReadonlyArray<string> = ["Still on it, give me a sec.", "One sec, the Chief's setting that up.", "Working on it, hang on.", "Give me a moment, it's getting sorted."];
export const workingLine = (seed: string) => vary(seed, WORKING_LINES);
export const GOODBYE_ANSWER = "Hanging up.";
/** What the voice says when the call wraps itself up. */
export const QUIET_GOODBYE = "I'll let you go. Everything's on the board, and I'll ring when it's ready.";
export const QUIET_GOODBYE_NO_RING = "I'll let you go. Everything's on the board.";
export const MAX_LENGTH_GOODBYE = "We've been on a while, so I'll hang up here. The work keeps going.";
export const CAP_GOODBYE = "That's today's limit for calls, so I have to go. Notes still land on the board.";

// ----------------------------------------------------------------- spoken words

/** Plain words from a model's text: markdown, code, links, paths and ids out; at most `sentences` sentences. */
export const spoken = (raw: string, sentences = 2) => {
  const text = raw
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`]*)`/g, (_, code: string) => (/[/\\.]|^\w+_\w+|\(/.test(code) ? "" : code))
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/https?:\/\/\S+/g, "")
    .replace(/\b(?:ci|ws|vc|item)-[0-9a-f]{6,}\b/gi, "")
    .replace(/(?:^|\s)[\w.-]*\/[\w./-]+/g, " ")
    .replace(/^#+\s*/gm, "")
    .replace(/^\s*(?:[-*+]|\d+\.)\s+/gm, "")
    .replace(/[*_~>|#]+/g, "")
    .replace(/\s+/g, " ")
    .trim();
  const parts = text.match(/[^.!?]+[.!?]+(?=\s|$)|[^.!?]+$/g) ?? [];
  return parts
    .slice(0, sentences)
    .map((s) => s.trim())
    .join(" ")
    .trim();
};

/**
 * A title as it is said: plain words, lower case unless it is a name. Quotes and backticks go; "+" and "&" are
 * "and"; a dash or underscore between words is a space ("rethink-the-memory-ui" is "rethink the memory ui").
 */
export const said = (title: string) => {
  const t = title
    .trim()
    .replace(/[`"'“”‘’]/g, "")
    .replace(/\s*[+&]\s*/g, " and ")
    .replace(/(?<=\w)[-_/](?=\w)/g, " ")
    .replace(/\s+/g, " ")
    .replace(/[.!?:]+$/, "");
  return /^[A-Z][a-z]/.test(t) && !/^[A-Z][a-z]+[A-Z]/.test(t) ? t[0]!.toLowerCase() + t.slice(1) : t;
};
/** A project as it is said: its own name, never an owner prefix, dashes and underscores as spaces ("caveman-code" is "caveman code app"). */
export const projectSaid = (name: string) =>
  (name.split("/").pop() ?? name)
    .replace(/\.git$/, "")
    .replace(/[-_.]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
/** Words that end a transcribed turn when the person is still thinking: a filler, a connector, a trailing comma, or no end at all. */
const TRAILING = /(?:\b(?:and|but|or|so|like|um|uh|er|because|maybe|then|also|plus|with|the|a|to|of|for|i mean|you know|kind of|sort of|i don't know|i dunno)|,|-|\.\.\.|…)\s*[.!?]*\s*$/i;
/** The turn sounds unfinished: more is likely coming, so a note made of it should wait longer. */
export const unfinished = (text: string) => {
  const t = text.trim();
  return t === "" || !/[.!?…]$/.test(t) || TRAILING.test(t);
};
const capital = (s: string) => (s === "" ? s : s[0]!.toUpperCase() + s.slice(1));
/** One of a few ways to say the same thing, picked by the words so a call never repeats itself in a row. */
const vary = (seed: string, options: ReadonlyArray<string>) => {
  let h = 0;
  for (const c of seed) h = (h * 31 + c.charCodeAt(0)) | 0;
  return options[Math.abs(h) % options.length]!;
};
const inProject = (project: string | undefined) => (project ? `, in ${project}` : "");
const list = (names: ReadonlyArray<string>) => (names.length <= 1 ? (names[0] ?? "") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`);

/** A Chief tool that ran for a note from this call, and what it returned. */
export interface ToolRun {
  readonly name: string;
  readonly input: Record<string, unknown>;
  readonly result: unknown;
  readonly failed: boolean;
}

const record = (value: unknown): Record<string, unknown> => (typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {});
const str = (value: unknown) => (typeof value === "string" ? value : "");

/**
 * What the voice says the moment one of the Chief's actions lands, or undefined for one it keeps quiet (a read).
 * `chats` names a chat by its id; `project` names a project.
 */
export const resultLine = (run: ToolRun, names: { readonly chat: (id: string) => string | undefined; readonly project: (id: string) => string | undefined }) => {
  const input = run.input;
  const result = record(run.result);
  const title = str(input.title) || str(result.title);
  const t = said(title || "that");
  const T = capital(t);
  if (run.failed) {
    if (run.name === "chat_start") return `Hmm, the Chief couldn't start that: ${spoken(str(run.result) || "it was refused", 1)}`;
    return undefined;
  }
  switch (run.name) {
    case "chat_start": {
      if (result.state === "proposed") {
        const projects = Array.isArray(input.project_ids) ? new Set(input.project_ids.map(String)) : new Set<string>();
        return projects.size > 1
          ? `${T} touches ${list([...projects].map((id) => names.project(id) ?? "another project"))}, so I've put it on the board for your okay first.`
          : vary(title, [`I've put ${t} on the board, it just needs your okay to start.`, `${T} is on the board. It'll start once you say so.`]);
      }
      if (result.state === "blocked") return vary(title, [`${T} is in line, it'll start as soon as there's room.`, `I've got ${t} queued up, it starts when a slot frees.`]);
      const chats = Array.isArray(result.chats) ? result.chats.map(record) : [];
      if (chats.length > 1) return `Okay, ${chats.length === 2 ? "two" : chats.length} chats are on ${t} now. I'll let you know when there's something to look at.`;
      const project = names.project(str(chats[0]?.project_id));
      return vary(title, [
        `Okay, someone's on ${t} now${inProject(project)}.`,
        `Alright, I've got a chat going on ${t}${inProject(project)}.`,
        `${T} is underway${inProject(project)}. I'll let you know when there's something to look at.`,
        `Yeah, ${t} is in progress${inProject(project)}, I'll keep you posted.`,
      ]);
    }
    case "chat_send": {
      const chat = said(names.chat(str(input.workspace_id)) ?? "the chat");
      return vary(chat, [`Okay, I've passed that along to ${chat}.`, `Told ${chat}, they're on it.`, `Alright, ${chat} has that now, they'll pick it up.`]);
    }
    case "chat_stop": {
      const chat = said(names.chat(str(input.workspace_id)) ?? "that chat");
      return vary(chat, [`Okay, I've stopped ${chat}.`, `${capital(chat)} is stopped, it won't go further.`]);
    }
    case "chat_answer": {
      const chat = said(names.chat(str(input.workspace_id)) ?? "the chat");
      return vary(chat, [`${capital(chat)} had a question, I've answered it.`, `Okay, I answered ${chat}'s question, it's carrying on.`]);
    }
    case "queue_add": {
      const what = said(title || str(input.text) || "it");
      return vary(what, [`Alright, I've queued up ${what}.`, `Okay, I've added ${what} to the queue.`]);
    }
    case "queue_update": {
      const state = str(input.state) || str(result.state);
      if (state === "queued") return title ? vary(title, [`Alright, I've queued up ${t}.`, `Okay, ${t} is in the queue, it'll wait there.`]) : "Okay, it's queued.";
      if (state === "dropped") return vary(title, ["Okay, dropped it.", "Alright, that's off the board."]);
      return undefined;
    }
    case "schedule": {
      const at = Date.parse(str(input.at) || str(result.not_before));
      return Number.isFinite(at) ? `Okay, that's set for ${new Date(at).toLocaleString("en-US", { weekday: "long", hour: "numeric", minute: "2-digit" })}.` : "Okay, that's scheduled.";
    }
    case "remember":
      return vary(str(input.text), ["Got it, I'll remember that.", "Noted, that'll stick.", "Sure, I've made a note of that."]);
    case "ask": {
      const question = spoken(str(input.question) || str(input.prompt), 1);
      const suggestion = spoken(str(input.recommended) || str(input.recommendation) || str(input.suggestion), 1);
      return question ? `Quick one from the Chief: ${question}${suggestion ? ` It'd go with ${said(suggestion)}.` : ""}` : undefined;
    }
    default:
      return undefined;
  }
};

/** A result after the first in one Chief turn, as a few words for the one "Also" line at its end (a question is never folded: it needs them). */
export const resultStub = (run: ToolRun, names: { readonly chat: (id: string) => string | undefined }) => {
  if (run.failed) return undefined;
  const input = run.input;
  const result = record(run.result);
  const t = said(str(input.title) || str(result.title) || "that");
  switch (run.name) {
    case "chat_start":
      return result.state === "proposed" ? `${t} needs your okay` : result.state === "blocked" ? `${t} is queued` : `someone's on ${t}`;
    case "chat_send":
      return `told ${said(names.chat(str(input.workspace_id)) ?? "the chat")}`;
    case "chat_stop":
      return `stopped ${said(names.chat(str(input.workspace_id)) ?? "that chat")}`;
    case "chat_answer":
      return `answered ${said(names.chat(str(input.workspace_id)) ?? "the chat")}`;
    case "queue_add":
      return `queued ${said(str(input.title) || str(input.text) || "it")}`;
    case "queue_update": {
      const state = str(input.state) || str(result.state);
      return state === "queued" ? `queued ${t}` : state === "dropped" ? "dropped it" : undefined;
    }
    case "schedule":
      return "scheduled it";
    case "remember":
      return "noted that";
    default:
      return undefined;
  }
};
/** The one line for everything after the first result of a Chief turn, so updates never stack. */
export const alsoLine = (stubs: ReadonlyArray<string>) => `Also, ${list(stubs)}.`;

/**
 * The `<call>` block a voice note carries to the Chief: what was on the person's screen (so "that" and "this" mean
 * that chat's work), then the call's last turns, each line marked you or voice.
 */
export const callBlock = (turns: ReadonlyArray<{ readonly role: "person" | "voice"; readonly text: string }>, showing?: { readonly title: string; readonly item_id: string; readonly workspace_id: string }) => {
  const lines = [
    ...(showing ? [`showing: "${showing.title.replace(/"/g, "'")}" (item ${showing.item_id}, chat ${showing.workspace_id}): what was on their screen; "that" and "this" mean it`] : []),
    ...turns.map((t) => `${t.role === "person" ? "you" : "voice"}: ${t.text.replace(/\s+/g, " ").slice(0, 400)}`),
  ];
  return lines.length === 0 ? "" : `<call>\n${lines.join("\n")}\n</call>`;
};

/** The chat a call block's showing line names (callBlock), or undefined: what Chief.ts reads to say which project a note points at. */
export const shownChat = (call: string | undefined) => /^showing: .* \(item [^,]+, chat ([^)]+)\)/m.exec(call ?? "")?.[1];

// ------------------------------------------------------------------- the board

/** A chat the voice may speak of: its title, project and state (the board's, else the chat's own). */
export interface VoiceChat {
  readonly title: string;
  readonly project?: string;
  readonly status: string;
}

/** A finished piece of work the voice can walk the person through. */
export interface Ready {
  readonly item_id: string;
  readonly title: string;
  readonly project?: string;
  readonly state: "review" | "done" | "needs_you";
  /** The chat's last answer: what it did, in its own words. The only facts the voice may state about it. */
  readonly report: string;
  /** needs_you: what it asks. */
  readonly detail?: string;
}

const itemTitle = (item: ChiefItem) => item.title ?? spoken(item.text, 1).slice(0, 80);

/** The board as the voice reads it: plain lines, no ids. */
export const boardText = (items: ReadonlyArray<ChiefItem>, others: ReadonlyArray<VoiceChat>, project: (id: string) => string | undefined) => {
  const where = (item: ChiefItem) => {
    const names = item.project_ids.map(project).filter((n): n is string => n !== undefined);
    return names.length === 0 ? "" : ` (${names.join(", ")})`;
  };
  const section = (label: string, lines: ReadonlyArray<string>) => (lines.length === 0 ? [] : [`${label}:`, ...lines.map((l) => `- ${l}`)]);
  const of = (states: ReadonlyArray<ChiefItem["state"]>) => items.filter((i) => states.includes(i.state));
  const lines = [
    ...section("Needs them", [
      ...of(["needs_you"]).map((i) => `${itemTitle(i)}${where(i)}: ${spoken(i.detail ?? "it needs them", 2)}`),
      ...of(["proposed"]).map((i) => `${itemTitle(i)}${where(i)}: waits for their okay to start`),
      ...others.filter((c) => c.status === "needs_input").map((c) => `${c.title}${c.project ? ` (${c.project})` : ""}: one of their own chats, waiting on them`),
    ]),
    ...section("Working", [...of(["started"]).map((i) => `${itemTitle(i)}${where(i)}`), ...others.filter((c) => c.status === "working" || c.status === "starting").map((c) => `${c.title}${c.project ? ` (${c.project})` : ""}`)]),
    ...section("Ready for review", of(["review"]).map((i) => `${itemTitle(i)}${where(i)}`)),
    ...section("Waiting to start", of(["blocked"]).map((i) => `${itemTitle(i)}${where(i)}: starts when there's room`)),
    ...section("Scheduled", of(["scheduled"]).map((i) => `${itemTitle(i)}${i.not_before ? `, ${new Date(i.not_before).toLocaleString("en-US", { weekday: "short", hour: "numeric", minute: "2-digit" })}` : ""}`)),
    ...section("Queued, in order", of(["queued", "unsorted"]).slice(0, 5).map(itemTitle)),
  ];
  const done = of(["done"]).filter((i) => i.updated_at.slice(0, 10) === new Date().toISOString().slice(0, 10)).length;
  if (done > 0) lines.push(`Done today: ${done}.`);
  return lines.length === 0 ? "The board is empty: nothing running, nothing queued." : lines.join("\n");
};

/**
 * A report the voice can walk through, as it reads it: the chat's own words and nothing else, marked as the only
 * facts it may state (2026-10-20: given a file list and a report, the voice read out files, tests and a replay run,
 * then described a screen the report never named).
 */
export const readyText = (ready: Ready) =>
  [
    `"${ready.title}"${ready.project ? ` in ${ready.project}` : ""} is ${ready.state === "review" ? "ready for review" : ready.state === "done" ? "done" : `stuck and needs them: ${spoken(ready.detail ?? "", 2)}`}.`,
    ready.report.trim() === ""
      ? "There is no report yet: you know nothing more about it, and say so if asked."
      : `The chat's report, the only facts you may state about it (leave out files, tests, runs and pull request plumbing):\n${ready.report.trim().slice(0, 1_500)}`,
  ].join("\n");

/** The prompt a call opens with: the instructions, then what is true now. */
export const openingPrompt = (input: {
  readonly board: string;
  /** The Chief's last exchanges, typed, oldest first. */
  readonly recent: ReadonlyArray<{ readonly role: "person" | "chief"; readonly text: string }>;
  readonly ready: ReadonlyArray<Ready>;
  readonly projects: ReadonlyArray<string>;
  readonly now: Date;
}) =>
  [
    VOICE_INSTRUCTIONS,
    "",
    `It is ${input.now.toLocaleString("en-US", { weekday: "long", hour: "numeric", minute: "2-digit" })} where they are.`,
    ...(input.projects.length === 0 ? [] : [`Their projects: ${input.projects.join(", ")}.`]),
    "",
    "The board right now:",
    input.board,
    ...(input.ready.length === 0 ? [] : ["", "Ready to walk them through:", ...input.ready.map(readyText)]),
    ...(input.recent.length === 0 ? [] : ["", "What they and the Chief said last, typed:", ...input.recent.map((r) => `${r.role === "person" ? "They" : "Chief"}: ${spoken(r.text, 3).slice(0, 300)}`)]),
  ].join("\n");

/** The first words of a call: what is ready, else what needs them, else a short hello. */
export const greeting = (input: { readonly ready: ReadonlyArray<Ready>; readonly needsYou: number; readonly hour: number; readonly seed: string }) => {
  const done = input.ready.filter((r) => r.state !== "needs_you");
  const stuck = input.ready.filter((r) => r.state === "needs_you");
  if (done.length === 1) return `Hey. ${capital(said(done[0]!.title))} is ready. Want the walkthrough?`;
  if (done.length > 1) return `Hey. ${done.length === 2 ? "Two" : done.length} things are ready: ${list(done.slice(0, 3).map((r) => said(r.title)))}. Which first?`;
  if (stuck.length > 0) return `Hey. ${capital(said(stuck[0]!.title))} needs you. Want to hear it?`;
  if (input.needsYou === 1) return "Hey. One thing on the board needs you. Want to hear it?";
  if (input.needsYou > 1) return `Hey. ${input.needsYou} things need you. Want to go through them?`;
  const hello = input.hour < 12 ? "Morning." : input.hour >= 18 ? "Evening." : "Hey.";
  return vary(input.seed, [`${hello} What's up?`, "Hey, I'm here.", `${hello} What are we building?`, "Hey. What do you need?"]);
};

/** What the voice says when work it handed off moves during the call. */
export const updateLine = (title: string, state: Ready["state"], detail?: string) =>
  state === "needs_you"
    ? `${capital(said(title))} needs you: ${spoken(detail ?? "it's stuck", 1) || "it's stuck."}`
    : vary(title, [`${capital(said(title))} is ready for you to look at. Want me to walk you through it?`, `${capital(said(title))} is ready for you to look at. Want the walkthrough?`]);
