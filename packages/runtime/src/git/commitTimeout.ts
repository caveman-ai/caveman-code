/** How long a commit may run: it runs the repository's hooks (husky, lint-staged, tsc), far past git's generic 30 s. */
export const COMMIT_TIMEOUT_MS = 10 * 60_000;
