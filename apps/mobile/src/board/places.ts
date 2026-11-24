// Where the phone's work lives. A phone holds no checkouts of its own: a project is a folder on your Mac (its
// project.list) or a GitHub repository, which Cloud clones. So what the phone can find and add depends on your Mac.
// Online, the Mac's folders and your repositories are searched; asleep or offline, only GitHub is, and a line says
// so. A folder that is only on that Mac starts its chats there, never in Cloud (which clones from GitHub) or on
// another Mac. A Mac goes by its own name, never "This Mac": the phone isn't one. Every picker reads these from here,
// and a project added in one shows in all of them at once. Scripted, as the rest of board/.
import { CLOUD_NEEDS_GITHUB, CLOUD_OFF } from "../live/words";
import { keep } from "../screens/pages/keep";
import { DEVICES, type Device, PROJECTS, startDevices } from "./model";

/** Where a repository turned up: your Claude or Codex sessions there, or beside your other code. */
export type Source = "claude" | "codex" | "folder";

/** A project, or a repository worth adding as one (Session Protocol Project and ProjectCandidate). */
export interface Place {
  name: string;
  /** owner/name on GitHub; absent, a folder only on your Mac. */
  github?: string;
  /** Where its checkout is on your Mac; absent, only on GitHub, so adding it clones it. */
  path?: string;
  sources?: readonly Source[];
  /** How lately it was used. */
  age?: string;
  private?: boolean;
  /** Added on this phone, on a board that is a computer's own: kept when that computer's projects are read again. */
  added?: true;
}

/** Whether the projects are a real computer's (`adoptProjects`), not the scripted world's. */
let live = false;
const isLive = () => live;

/** This Caveman runs no Cloud for the person's organization (live/link.ts, from Caveman's own word): Cloud is listed, as its reason, and cannot be picked. */
let cloudOff = false;
export const adoptCloudOff = (off: boolean) => {
  cloudOff = off;
};

/** The Mac a folder project lives on: the scripted world's own Mac, or on the person's own board their Mac. */
export const pairedMac = (): Device | undefined =>
  DEVICES.find((d) => d.self && d.kind === "mac") ??
  (live ? DEVICES.find((d) => d.kind === "mac") : undefined);

/** Whether the paired Mac answers now, so its disk can be searched and a folder on it added. */
export const macReachable = () => pairedMac()?.status === "online";

/** The paired Mac in a sentence: its name, or "your Mac" when this phone drives none. */
export const macName = () => pairedMac()?.name ?? "your Mac";

/** Where an automation runs ("mac": your Mac, "cloud": a Cloud computer), by name. */
export const runsOnName = (where: "mac" | "cloud") => (where === "mac" ? macName() : "Cloud");

const WHERE: Record<string, Omit<Place, "name">> = {
  "caveman-code": { github: "caveman-ai/caveman-code", path: "~/code/caveman-code" },
  "Caveman Cloud": { github: "Caveman Cloud", path: "~/code/Caveman Cloud" },
  // Its chats run on Studio and in Cloud and open pull requests, so it is on GitHub like the rest: a folder on no
  // GitHub lives on the paired Mac alone, and the scripted world has none (one can be added from the Mac's disk).
  marketing: { github: "caveman-ai/marketing", path: "~/Documents/marketing" },
  "caveman-agent-sdk": { github: "caveman-ai/caveman-agent-sdk", path: "~/code/caveman-agent-sdk" },
};

const scripted = (): readonly Place[] => PROJECTS.map((name) => ({ name, ...WHERE[name] }));

/** Your projects (project.list), oldest first. One added anywhere shows in every list at once. */
export const projects = keep<readonly Place[]>(() => (live ? [] : scripted()));

/**
 * The person's real projects take the scripted ones' place on a board that is a computer's own (live/link.ts: the
 * Mac's project.list while it answers, what Caveman keeps of their projects, and the repositories their chats are in);
 * null puts the scripted ones back. One added from the phone meanwhile stays.
 */
export function adoptProjects(real: readonly Place[] | null) {
  live = real !== null;
  if (!real) cloudOff = false;
  if (!real) return projects.set(scripted());
  projects.set((was) => [...real, ...was.filter((p) => p.added && !real.some((r) => same(r, p)))]);
}

/** A project by its name, as chats know it. */
export const placeOf = (name: string) => projects.get().find((p) => p.name === name);

/**
 * What project.discover found, best first: one per repository, with both its checkout on your Mac and its GitHub link
 * where it has both. The Mac's checkouts come only while it answers; your repositories come through Caveman Cloud.
 */
const DISCOVERED: readonly Place[] = [
  {
    name: "web-app",
    github: "acme/web-app",
    path: "~/code/web-app",
    sources: ["claude", "codex"],
    age: "1d",
    private: true,
  },
  { name: "docs-site", github: "acme/docs-site", age: "3d", private: true },
  {
    name: "cli-tools",
    github: "acme/cli-tools",
    path: "~/code/cli-tools",
    sources: ["folder"],
  },
  { name: "notes", path: "~/Documents/notes", sources: ["folder"] },
  { name: "dotfiles", github: "dev/dotfiles", age: "2w" },
];

/**
 * What can be added now: everything the Mac found while it answers; else your repositories, none of them from its
 * disk. None on a board that is a computer's own: the phone suggests nothing it was not told, and a pasted link,
 * owner/name or path adds a project there.
 */
export const candidates = (): readonly Place[] =>
  isLive()
    ? []
    : macReachable()
      ? DISCOVERED
      : DISCOVERED.flatMap((p) => (p.github ? [{ ...p, path: undefined, sources: [] }] : []));

/** The same repository or folder, or a project of the same name (chats know their project by name). */
const same = (a: Place, b: Place) =>
  a.name === b.name || (!!a.github && a.github === b.github) || (!!a.path && a.path === b.path);
export const isProject = (place: Place, list: readonly Place[]) => list.some((p) => same(p, place));

/**
 * Adds `place` as a project, or finds the one it already is. A repository with a checkout on the Mac uses that
 * checkout; one only on GitHub is cloned into ~/code there while it answers, or else by the Cloud computer its first
 * chat starts on.
 */
export function addProject(place: Place): Place {
  const was = projects.get().find((p) => same(p, place));
  if (was) return was;
  const found = candidates().find((p) => same(p, place));
  // On a real Mac only the Mac says where a clone lands: no path is made up for it.
  const path =
    place.path ??
    found?.path ??
    (place.github && macReachable() && !isLive() ? `~/code/${place.name}` : undefined);
  const added: Place = {
    name: place.name,
    github: place.github ?? found?.github,
    path,
    ...(isLive() ? { added: true as const } : null),
  };
  projects.set((all) => [...all, added]);
  return added;
}

/** What a field holds: a folder's path, a GitHub link or owner/name, or words to search by (project-candidates.ts readAddField). */
export type Typed =
  | { kind: "path" | "repo"; place: Place; needle: string }
  | { kind: "search"; needle: string };

export function readTyped(query: string): Typed {
  const q = query.trim();
  if (/^[~/]/.test(q) && q.length > 1) {
    const path = q.replace(/\/+$/, "") || q;
    return { kind: "path", place: { name: path.split("/").pop() || path, path }, needle: path };
  }
  const gh = q.match(
    /^(?:https?:\/\/)?(?:www\.)?(?:github\.com\/)?([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/,
  );
  return gh
    ? {
        kind: "repo",
        place: { name: gh[2]!, github: `${gh[1]}/${gh[2]}` },
        needle: `${gh[1]}/${gh[2]}`,
      }
    : { kind: "search", needle: q };
}

export const matches = (p: Place, needle: string) =>
  !needle ||
  `${p.name} ${p.github ?? ""} ${p.path ?? ""}`.toLowerCase().includes(needle.toLowerCase());

/**
 * Why a chat in `place` can't start on `device`, in a row's words; null when it can. Only a folder that is on no
 * GitHub is bound: it lives on the paired Mac alone. Asleep or offline doesn't bar a computer: a chat there waits for
 * it ("Waiting for Studio", docs/).
 */
export function blocked(place: Place | undefined, device: Device): string | null {
  // A real Mac takes a new chat only while it answers: nothing queues one for a Mac that sleeps.
  if (isLive() && device.kind === "mac" && device.status !== "online")
    return `${device.name} is ${device.status === "offline" ? "offline" : "asleep"}`;
  if (isLive() && device.kind === "cloud" && cloudOff) return CLOUD_OFF;
  if (!place || place.github || device.id === pairedMac()?.id) return null;
  return device.kind === "cloud" ? CLOUD_NEEDS_GITHUB : `This project is a folder on ${macName()}`;
}

/** The computer a chat in `place` starts on: the one asked for when it can, else the first that can. */
export function settle(place: Place | undefined, wanted: Device): Device {
  if (!blocked(place, wanted)) return wanted;
  return startDevices().find((d) => !blocked(place, d)) ?? wanted;
}

/** What a picker says over its list while the phone can't search the Mac; null while it can. */
export const searchNote = () => {
  const mac = pairedMac();
  if (macReachable()) return null;
  // On the person's own board the Mac's own row, right above, says it is asleep or offline: nothing says it twice.
  if (isLive()) return null;
  if (!mac) return "Only GitHub is searched. Chats start in Cloud.";
  return `${mac.name} is ${mac.status === "asleep" ? "asleep" : "offline"}, so only GitHub is searched. Its folders show when it wakes.`;
};
