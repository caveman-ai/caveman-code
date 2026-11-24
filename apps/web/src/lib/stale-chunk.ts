// A part of the app loaded on first use (a screen, a side panel tab) that the
// browser can no longer fetch: the app was updated under the open page, so the
// old build's chunk names are gone. Retrying the import fails again (the
// browser caches the failure); only reloading the page brings the new build.
const MESSAGES = /Failed to fetch dynamically imported module|Importing a module script failed|error loading dynamically imported module|Unable to preload CSS/i;

export function isStaleChunk(error: unknown): boolean {
  return MESSAGES.test(error instanceof Error ? error.message : String(error));
}
