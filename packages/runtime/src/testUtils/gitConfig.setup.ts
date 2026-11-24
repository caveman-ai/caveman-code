// ), apps/server/src/testUtils/gitConfig.setup.ts @ ab3a3cd1.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// Pins git behaviour for every repository the suite creates, ahead of the
// host's ~/.gitconfig. Git for Windows installs with core.autocrlf=true,
// which checks committed LF files out as CRLF and breaks every byte-exact
// content assertion; a signing key or a non-default init branch on the
// developer's machine breaks fixtures the same way. Set as environment so
// each git child the driver spawns sees it without touching the fixtures.
const entries: ReadonlyArray<readonly [key: string, value: string]> = [
  ["core.autocrlf", "false"],
  ["core.filemode", "false"],
  ["core.longpaths", "true"],
  ["commit.gpgsign", "false"],
  ["tag.gpgsign", "false"],
  ["init.defaultBranch", "main"],
];

const existing = Number(process.env.GIT_CONFIG_COUNT ?? "0");
process.env.GIT_CONFIG_COUNT = String(existing + entries.length);
entries.forEach(([key, value], index) => {
  process.env[`GIT_CONFIG_KEY_${existing + index}`] = key;
  process.env[`GIT_CONFIG_VALUE_${existing + index}`] = value;
});
// With no user.email anywhere (a scratch HOME), git guesses user@hostname and
// refuses a dotless hostname ("Mac"), failing every fixture commit. EMAIL is
// git's fallback below user.email, so a fixture's own identity still wins.
process.env.EMAIL ??= "test@example.invalid";
// Nor has every account a full name: on GitHub's Linux runners git refuses the
// "empty ident name". A system config file is git's lowest-precedence layer, so a
// fixture's own user.name (repo, global or -c) still wins over this fallback.
if (!process.env.GIT_CONFIG_SYSTEM) {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "caveman-git-system-")), "gitconfig");
  fs.writeFileSync(file, "[user]\n\tname = Caveman Test\n");
  process.env.GIT_CONFIG_SYSTEM = file;
}
