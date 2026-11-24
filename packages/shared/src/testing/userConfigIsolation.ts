// Every package's tests run in a scratch home (vitest.config.ts sets HOME and
// the XDG/AppData dirs). These two point straight at the developer's Claude
// and Codex logins and win over HOME, so they are removed, not repointed:
// tests that need them set them; the rest see the scratch home's defaults.
delete process.env.CLAUDE_CONFIG_DIR;
delete process.env.CODEX_HOME;

// Git exports these to hooks and to `git bisect run`. Inherited, they point every git child of a test (fixture
// helpers and the code under test alike) at the developer's own repository instead of the scratch repo in its cwd:
// fixture commits land there, and a fixture's `git push origin` targets the real remote.
for (const name of [
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_INDEX_FILE",
  "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_COMMON_DIR",
  "GIT_NAMESPACE",
  "GIT_PREFIX",
]) {
  delete process.env[name];
}
