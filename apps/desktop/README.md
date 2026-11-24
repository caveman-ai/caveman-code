# Caveman Code desktop (`@caveman-app/desktop`)

The macOS and Windows (x64) app: an Electron shell that starts the local
runtime (`packages/runtime`) as a child process and loads the web client
(`apps/web` build output) from disk: `apps/web/dist` in development, and in
the packaged app `<resources>/runtime/client`, the runtime bundle's copy (one
copy, which the runtime also serves at `/`). `<resources>` is
`Caveman Code.app/Contents/Resources` on macOS and `<install dir>\resources`
on Windows (`process.resourcesPath`). It's , `ab3a3cd1`) without upstream
Effect layer graph. It has one window and one local runtime.

```sh
pnpm --filter @caveman-app/desktop dev          # build apps/web, bundle main, start Electron
pnpm --filter @caveman-app/desktop smoke-test   # headless: runtime answers engine.list, app quits
node apps/desktop/scripts/smoke-test.mjs --fixture             # same, with test/fixture-runtime.mjs
pnpm app                                        # macOS: build origin/main (--ref <ref> for another) and swap it into /Applications
scripts/install-app.sh --auto                  # for an hourly automation: build when main moves, install once the app is closed
pnpm --filter @caveman-app/desktop package      # macOS: release/Caveman-Code-<v>-<arch>.{dmg,zip} + latest-mac.yml (+ .app)
                                                # Windows: release/Caveman-Code-Setup-<v>-x64.exe + .blockmap + latest.yml (+ win-unpacked)
node apps/desktop/scripts/smoke-test.mjs --packaged            # smoke the packaged app and its runtime
node apps/desktop/scripts/smoke-test.mjs --app <executable>    # smoke another copy, e.g. the installed Caveman Code.exe
CAVEMAN_SMOKE_WINDOW=<file.png> node apps/desktop/scripts/smoke-test.mjs  # off macOS: also show the window, picture it with
                                                # its caption buttons and click maximize (src/main.ts)
node apps/desktop/scripts/first-run-e2e.mjs --packaged          # a first run from empty folders through the window: onboarding
                                                # from the first paint, sign-in, an older Claude Code listed and
                                                # updated, a Chief turn (--app <executable>, --out <dir>; a real
                                                # Cloud with CAVEMAN_E2E_CLOUD_URL, _EMAIL, _PASSWORD)
pnpm --filter @caveman-app/desktop icon         # resources/icon.{svg,png,icns,ico}: the pixel flame, from scripts/make-icon.py
```

## Runtime contract (what the desktop expects from `packages/runtime`)

- Command: development runs
  `node --disable-sigusr1 packages/runtime/src/bin.ts --bootstrap-fd 3` on the
  system Node 22. The packaged app runs `<resources>/runtime/node
  --disable-sigusr1 <resources>/runtime/bin.mjs --bootstrap-fd 3`
  (`runtime\node.exe` on Windows)
  (`--disable-sigusr1`: no process of the user can `kill -USR1` the runtime
  into opening an inspector; the smoke test checks it):
  `scripts/package.mjs` copies `packages/runtime/dist/` (the bundle, its
  external `node_modules`, `manifest.json` and `THIRD_PARTY_LICENSES.txt`, from
  `pnpm --filter @caveman-app/runtime build`) and Node 24.21.0 from nodejs.org
  (Electron 44's own Node version; the macOS tarball or Windows zip is cached
  in `.cache/` and checked against the pinned sha256 on every run) there,
  with the pinned `caveman-proxy`, `caveman-mcp` and `caveman-engine` in
  `runtime/bin` (`.exe` on Windows). The Electron binary
  never acts as Node, so its runAsNode fuse is off; the runtime's own
  children (plugin launcher, ACP bridge) re-run `process.execPath`, which is
  that Node. `CAVEMAN_RUNTIME_ENTRY` overrides the entry in development, and in
  a packaged build only under `--smoke-test` (still on the bundled Node).
- Bootstrap: one JSON line on fd 3, upstream `DesktopBackendBootstrap`
  (`@caveman-app/protocol`): `{mode: "desktop", noBrowser: true, host:
  "127.0.0.1", port, t3Home?, desktopBootstrapToken, tailscaleServeEnabled:
  false, tailscaleServePort: 443}`. The port is free and chosen by the desktop.
  The token is 32 random bytes as hex. Neither goes in argv or env. `t3Home`
  is the runtime's state dir: the dev profile sends `<userData>/runtime`; the
  packaged app omits it, so the runtime uses its default (`~/.caveman-code`),
  the same one `caveman code` uses. It also carries `agentsKey`, this Mac's
  agents key (src/agentsKey.ts), and nothing else does. The keychain unseals
  it only after Electron's `ready`, which comes while the runtime loads, so
  the line is written then; the runtime waits up to 5 minutes for it (T3
  waits 1 s), since the keychain may first ask the person.
- Endpoint and auth: started with `--bootstrap-fd`, the runtime serves Session
  Protocol at `ws://<host>:<port>/session/v1` and accepts
  `desktopBootstrapToken` as the bearer for its whole life (no TTL, no pairing
  exchange), as `Authorization: Bearer` or the `base64url.bearer.<token>`
  subprotocol. It also writes the token file (`packages/session-protocol`
  README, Auth), which `caveman code` reads, with a fresh token on every
  start. A restart gets the same port and bootstrap token.
- Lifecycle: stdin is a pipe the desktop never writes until it quits; EOF
  starts the runtime's graceful shutdown, the same path as SIGTERM, which
  ends its engines, ptys, proxy and mcp (so the desktop dying stops it too).
  On quit the desktop ends that stdin, then after 5 s ends what is left: on
  macOS the runtime leads its own process group, which gets SIGTERM, then
  SIGKILL; on Windows the runtime is not detached, and
  `taskkill /pid <pid> /T /F` ends its process tree (no signal reaches
  another process there). An unexpected exit restarts the runtime on the same port and
  bootstrap token, with backoff from 0.5 s doubling to 10 s, reset after 30 s up. The
  client reconnects on its own. Exit code 78 (`SERVER_EXIT_CODE_STATE_DIR_OWNED`:
  another runtime owns the state dir, for example one `caveman code`
  started) is never restarted: the app attaches to that runtime through
  `<state dir>/userdata/server-runtime.json` and the token file beside it
  (packages/shared runtimeDiscovery: files owned by this user and writable
  by nobody else, a loopback origin, a live pid that started before the
  record). Otherwise the app says why and quits, as T3 does.

The preload exposes `window.cavemanDesktop = { runtime: { url, token }, packaged }`
(read by `apps/web/src/state/runtime.tsx`; `packaged` is true in a packaged
app that is not the smoke test, from the main window's `--caveman-packaged`
renderer argument). Only pages on
`caveman-code://app/` get it; the same check gates permissions, and only
clipboard writes are granted.

## Signing, notarization, updates

On macOS `scripts/package.mjs` signs ad-hoc (`mac.identity: "-"`), or with the
identity in `CSC_LINK` + `CSC_KEY_PASSWORD` (a Developer ID .p12) or
`CSC_NAME` (a keychain identity). Either way electron-builder re-signs every
Mach-O inside, including `runtime/node` and the natives in
`runtime/node_modules`. Signed builds use the hardened runtime and
`resources/entitlements.mac.plist` (JIT only, no
`disable-library-validation`: the natives carry the app's team). Ad-hoc
builds skip the hardened runtime, whose library validation refuses natives
without a team. A signed build is notarized (and stapled) when notarytool
credentials are in the environment as well: `APPLE_API_KEY` +
`APPLE_API_KEY_ID` + `APPLE_API_ISSUER`, or `APPLE_KEYCHAIN_PROFILE`, or
`APPLE_ID` + `APPLE_APP_SPECIFIC_PASSWORD` + `APPLE_TEAM_ID`. The app is
notarized and stapled before the .dmg and .zip are made, so both carry the
stapled app. A signed build signs the .dmg with the same identity and does not
notarize it, as T3 and electron-builder do: Gatekeeper judges the app inside,
and a second submission added minutes to every release. `--release` refuses
to build without an identity and credentials, then asks Gatekeeper about the
app (`spctl --assess`, `stapler validate`), checks the .dmg's signature
(`codesign --verify`), and mounts the .dmg to ask Gatekeeper about the app
inside it, the copy a person drags out of a download. No signing material
lives in this repo.

An ad-hoc build is for the Mac it was built on. Anyone else should get the
signed release (`desktop-release.yml`): downloaded, an ad-hoc app is
quarantined, and on Apple silicon macOS says it "is damaged and can't be
opened" (on Intel, that it can't verify it). If they must run it, after
dragging it to Applications: `xattr -dr com.apple.quarantine
"/Applications/Caveman Code.app"` (`package.mjs` prints this after an ad-hoc
.dmg). An ad-hoc build has no update feed: Squirrel.Mac installs only an
update signed as the running app is. On a Mac that already has another
Caveman Code, macOS asks once to let it use the "Caveman Code Safe Storage"
keychain item (Always Allow); a scripted run passes `--use-mock-keychain`.

The app says it runs on macOS 13.5 or newer (`MAC_MINIMUM`, the bundled
Node's own minimum), and packaging fails if anything in the runtime needs
more, except natives that only one feature loads and that feature does
without (`MAC_OPTIONAL`: node-datachannel, 14.0, for direct connections to
devices, which otherwise go through the relay). On Windows the runtime
carries the Visual C++ runtime DLLs its natives import (fff_c.dll for file
search, onnxruntime for chat search), from Visual Studio's redistributable
folder, beside `node.exe` and beside each native; `scripts/check-natives.mjs`
loads them after every build, and `windows.yml` loads them again in Windows
Server Core, which has no Visual C++ runtime.

The .dmg opens a 640 x 400 window titled Caveman Code: the background from
`scripts/make-dmg-background.py` (`resources/dmg-background.tiff`, 1x and 2x),
the app at (180, 190) and an Applications link at (460, 190), 128 px icons, the
flame as the volume's icon. Started from there or from Downloads, the packaged
app first asks to move itself into Applications (`src/moveToApplications.ts`,
`app.moveToApplicationsFolder`), where it can update itself; Not Now holds
until the next version. The copy that opens in Applications ejects the
installer volume it came from (`hdiutil detach`). The smoke test never asks.

On Windows (x64) it builds `release/win-unpacked` and a one-click, per-user
NSIS installer (`Caveman-Code-Setup-<version>-x64.exe`, no administrator;
`/S` installs silently into `%LOCALAPPDATA%\Programs\caveman-code`), with a
differential package so updates download only changed blocks, the flame on
the installer, the uninstaller and its header, and the same fuses. It is unsigned unless Azure Artifact Signing is in the environment:
`AZURE_TENANT_ID`, `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET` and
`AZURE_TRUSTED_SIGNING_ENDPOINT`, `_ACCOUNT_NAME`, `_CERTIFICATE_PROFILE_NAME`,
`_PUBLISHER_NAME`. Then electron-builder signs every `.exe`, `.dll` and
`.node` with Authenticode, the runtime's (`node.exe`, the caveman binaries,
its natives) included, or the build fails; `--release` refuses to build
without them and asks Windows to accept every signature. An unsigned build
runs, but SmartScreen warns. The self-checks run on both: the fuses read
back, a pty from the bundled node-pty on the bundled Node (ConPTY on
Windows), and the bundled `caveman-proxy` answering from a scratch home.

`.github/workflows/desktop-release.yml` (by hand only) takes the signing
material from repository secrets, builds macOS arm64 and x64 and Windows x64
on their own runners (Windows only once its Azure secrets exist: an unsigned
build never ships), merges the macOS `latest-mac.yml`, smokes each build (the
Windows one installed silently too), stages everything in the R2 bucket
`caveman-downloads` under versioned names and stops at a draft GitHub
release. It builds nothing until `releases/<version>.md` says what changed
(`scripts/release-notes.mjs`, `releases/README.md`); those notes become the
release body and the app's What's new.

Updates (`src/updates/`, electron-updater, ported from upstream `updates/`) have
two channels, picked in Settings > General and kept in the app's
`update-channel.json`:

- **Stable** reads `https://download.caveman.so/code/mac`, or `/code/win` on
  Windows (that bucket on its custom domain), as written into
  `<resources>/app-update.yml`.
- **Nightly** reads the same path with `nightly/` before the platform,
  `/code/nightly/mac` and `/code/nightly/win`, where
  `.github/workflows/desktop-nightly.yml` publishes a build of main every day as
  `<next>-nightly.<YYYYMMDD>.<run>` (`scripts/nightly-version.mjs`), once the
  repository variable `NIGHTLY_ENABLED` is `true`. A nightly build follows
  Nightly until someone picks Stable.

Either way an update installs only when it is on the channel picked and newer
than the running build (`updateChannels.ts` `offerable`, and electron-updater's
own downgrades stay off): a nightly sorts below the release it leads to, so a
Mac switched back to Stable keeps its nightly until a newer stable ships, and
an older runtime never opens a database a nightly migrated. Checks run 15 s
after launch and every 6 h with no login; an update found is judged first,
then downloaded in the background, and installs on quit or from Settings >
General (`updateMachine.ts` holds every state, `releaseNotes.ts` reads the
feed's notes for the row). macOS offers the restart once Squirrel.Mac has
accepted the download; Windows once electron-updater has the installer (in a
signed build, checked against this app's publisher), which then runs silently
and reopens the app. An install leaves `update-install.json` so the next start
can say when it did not take. A staged build reaches no one; publishing its
draft release runs `.github/workflows/desktop-publish.yml`, which copies the
version's `latest-mac.yml` and `latest.yml` to the feeds' roots, and its DMGs
and installer to the stable `Caveman-Code-arm64.dmg`, `Caveman-Code-x64.dmg`
and `Caveman-Code-Setup-x64.exe` the site links to. Run that workflow by hand
with an earlier version to send new downloads back to it; installed apps
never downgrade.
`CAVEMAN_UPDATE_FEED_URL` points a packaged build made without `--release` at
a generic feed instead (the update test; Nightly is it with `nightly/`
added); release builds ignore it. `scripts/mock-update-server.mjs <root>
[port]` serves a folder laid out as the bucket is for that test.

When the runtime cannot start, `src/startupRecovery.ts` (upstream
`DesktopStartupRecovery`) opens a small window of its own instead of a page
that says Reconnecting: after the runtime exited several times in a row as it
started, or at once when it refused its database because a newer build wrote
it (exit 79 or its `DatabaseNewerThanRuntime` line; it is not restarted, and
nothing is deleted). It shows what the runtime said and offers a newer build
when the updater has one, else the build that last started here (not for newer
data) or the newest download, with Try again, Report a problem, Copy details,
Show logs and Quit. Report a problem opens the page's problem report over the
app's window, prepared from this app's own log while the runtime is down
(`src/bugReport.ts`); closing it brings the recovery window back.
When the app attaches to a runtime it did not start (`caveman-code` in a
terminal) whose `server-runtime.json` names another build, the log and
Settings > General say so; that runtime is never signalled or stopped.

The packaged macOS runtime starts from prepared V8 bytecode
(`src/serverCompileCache.ts`, upstream prepared server cache): `package.mjs`
compiles the runtime's start with the bundled Node before signing, into
`runtime/compile-cache`, and the app starts the runtime with
`--import=runtime/serverCompileCache.mjs`, which links those files into a
compile cache of this user's. Windows has neither: Node's compile cache stays
off there: its synchronous writes slowed the start by seconds.
`pnpm profile:startup` profiles the runtime's start, from source or
`--packaged <app>` (`scripts/profile-startup.mjs`).

## Command line and telemetry

The packaged app keeps `~/.caveman-code/bin/caveman-code` current (`src/cli.ts`;
never on PATH by itself, and not named `caveman`, which is the v4 CLI's): the
bundled Node runs the bundled runtime's `caveman code`. Settings > General
(or the first-run screen) links it into `/usr/local/bin`, asking macOS for an
administrator when needed. On Windows it is `caveman-code.cmd` in
`~/.caveman-code/bin`, and Install adds that folder to the user PATH (HKCU),
with no administrator. The same command ships on npm as
`@caveman-ai/code`, a launcher that runs the platform package npm installs
beside it (`@caveman-ai/code-<platform>-<arch>`: darwin-arm64, darwin-x64,
linux-arm64, linux-x64, win32-x64), from `pnpm --filter @caveman-app/runtime
pack:npm`, packed and smoked on each platform's runner and published by
`.github/workflows/npm-release.yml`.

Crash and onboarding counts (`src/telemetry.ts`) go to Caveman Cloud's
`POST /telemetry/cli` in the CLI's `cli/v1` envelope: crash kind and reason,
funnel step names, app version, OS and arch, an anonymous id. Never prompts,
code, paths, messages or stacks in these counts. Opt-out with
disclosure, as Cloud the spec asks of the CLI: nothing leaves until the first
onboarding screen has shown what is sent beside its switch; earlier events wait
in memory and go with that screen's step. Off under Settings > General, that
switch, or `DO_NOT_TRACK` / `CAVEMAN_TELEMETRY=0`; `CAVEMAN_TELEMETRY_URL`
redirects it in builds made without `--release` (tests).

Crash reports (`src/crashReports.ts`, `docs/`) carry
the stack and scrubbed message of what failed in main, the page and the
runtime, and native crashes' minidumps, to Sentry. They go under the same
switch, once a line naming them has shown, and only while the app uses
Caveman's own Cloud. A release bakes in `CAVEMAN_CRASH_DSN`. Without it, or
off, minidumps stay in the app's crashDumps directory and nothing uploads them;
`CAVEMAN_CRASH_DSN` in the environment names a test receiver in builds made
without `--release`. Fuses are set at package time and read back
after it: run-as-node, NODE_OPTIONS and `--inspect` are off, and the app
loads only from its integrity-checked app.asar. The script then verifies the
signature (`codesign --verify --deep --strict` on macOS, Authenticode on a
signed Windows build) and spawns a pty from the bundled node-pty on the
bundled Node. `<resources>/` carries `THIRD_PARTY_NOTICES.md` and the
Electron, Chromium and Node licenses; `<resources>/runtime/` carries the
licenses of the packages inlined into the runtime bundle, and
`runtime/bin/licenses` those of the caveman binaries.

## Dropped from T3

Clerk and T3 Connect, mobile pairing, SSH/WSL/Tailscale backends, the
backend pool, managed update policy and remote (fleet) updates, browser previews and
snapshots, telemetry fds, legacy localStorage migration, the
dev-server proxy, the Linux desktop and Windows arm64 builds, and the shell-environment PATH
import (the runtime hydrates PATH itself when `shellEnvironmentPrepared` is
absent).
