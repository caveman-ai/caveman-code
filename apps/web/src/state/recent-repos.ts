// The repositories this browser started work in lately, newest first (localStorage): onboarding remembers the one it
// added, and Settings > Secrets lists them beside the chats' own.
const RECENT_KEY = "caveman.recentRepos";

export function recentRepos(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(RECENT_KEY) ?? "[]") as unknown;
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

export function rememberRepo(path: string): void {
  localStorage.setItem(
    RECENT_KEY,
    JSON.stringify([path, ...recentRepos().filter((p) => p !== path)].slice(0, 8)),
  );
}
