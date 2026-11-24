# Caveman Code on a phone

native shape with Caveman Code inside. Home is a new chat that greets you
and says what waits. The sidebar sits behind the main panel: pull requests,
automations, the Chiefs, then pinned chats, each project and recent ones. A
Chief's screen is a plain chat with its agents as a thread and its pixel
character sitting on the box. What needs you rises as a card you swipe yes
or no, and the round button calls the Chief.

The spec: `docs/` (the Chief's screen under "The
Chief"), its sizes and copy in `DECISIONS.md` beside it.

This is a prototype. The morning is scripted (`src/board/script.ts`, its world
in `src/board/world.ts`) and the mic "hears" canned words, until you sign in to
Caveman (Settings > Account). Then the board is your own: every chat of yours
on every computer, their transcripts as they happen, a chat started from the
phone, your messages, Stop and answers to what it asks, through Caveman
Cloud's relay on the same device protocol the desktop and web use ("Your own
chats" below). Nothing scripted is shown to someone who is signed in, and
signing out leaves an empty list beside "Sign in to Caveman". `start`, `send`,
`tellChief`, `allow`, `deny` and `stop` in `script.ts` are the seams; `start`,
`send`, the answers and `stop` reach the runtime for a real chat.

A phone holds no checkouts. Its projects are your Mac's and your GitHub
repositories, and what it can find and add depends on whether that Mac
answers (`src/board/places.ts`): asleep or offline, only GitHub is searched,
and a folder that is on no GitHub starts its chats on the Mac alone. On a real
computer's board the projects are your own: the Mac's while it answers, what
Caveman keeps of your projects, and the repositories your chats are in, each
repository by its own name on every computer.

Everything is kept on the phone and read back before the first frame, so the
app opens where you left it. `?fresh` on the web build, or Settings > About >
Start again, plays the morning from the top.

## Your own chats

Settings > Account: sign in to Caveman (a code to confirm on Caveman's page).
The sidebar is then one list of every chat on every computer of yours, by
project, each row with a small mark for where it runs, in the web's words
("In Cloud", "On Studio"), and that place's one state word when it does not
simply run ("In Cloud · Asleep"). Opening
a chat reaches its computer by itself. The one thing a Mac asks, once, is to
allow this phone: the chat says "On Studio, choose Allow when it shows this
code." with the code, which is this phone's own key's, so nothing between the
two can put another device in its place. The words a person reads are all in
`src/live/words.ts`, from `docs/`.

- One protocol, not a second copy: `src/live/connection.ts` runs
  `@caveman-app/session-protocol`'s own client, device handshake and sealed
  frames. A phone's JavaScript engine has no WebCrypto, so `src/live/webcrypto.ts`
  supplies the part the protocol uses (ECDSA and ECDH on P-256, HKDF and HMAC
  with SHA-256, AES-256-GCM, JWK keys) on the audited noble libraries
  (`@noble/curves`, `@noble/hashes`, `@noble/ciphers`): JavaScript only, so Expo
  Go still runs it. `index.ts` installs it before anything asks.
- The phone's device key is made on the phone and never leaves it. It and the
  Caveman sign-in are kept in the Keychain or Keystore (`expo-secure-store`,
  this device only, while unlocked; `src/live/native.ts`), never in the app's
  store. The web build is a preview: it keeps them in `localStorage`.
- `src/live/cloud.ts` signs in, lists your computers and chats and mints the
  relay's bearer. `link.ts` holds one `source.ts` per computer and reads
  Caveman's list again every few seconds (faster while something waits), so
  every list refreshes while it is open and a chat that runs somewhere else
  now is followed there by itself. `transcript.ts` turns a chat's events into
  the board's items; `seams.ts` says whether the board is the person's own.
- Nothing wakes a place except a send. A computer is reached only while
  something needs it (the chat on screen, a send, a start), and Cloud that
  sleeps is never woken for a look: the chat reads from what Caveman saved of
  it (`GET /code/chats/{id}/events`), its line says "Asleep", and there is no
  Wake, Connect or Disconnect anywhere.
- Sending is enough (`source.ts`, `away.ts`). To a place that does not answer,
  a message is queued in Cloud signed by this phone, and one line under it
  says what it waits for, a wait always as "<Doing>… 8s": "Waking Cloud… 4s";
  "Studio is asleep. Running in Cloud." where Caveman runs a sleeping Mac's
  chat itself; "Sends when Studio wakes" where it stays, with why by Cloud's
  code where that is news ("Folder project. Sends when Studio wakes.");
  "Paused until Saturday · plan used up", the reset from Cloud's own
  `resets_at`, so it reads with no Mac on line; after ten seconds with no
  network, "No network. Sends when you're back online.", and it goes by
  itself. A message that goes with its chat to another computer stays in the
  thread. What Caveman refuses stays too, marked "Not sent · Send again".
- An approval answered while its place sleeps reads "Allow queued · waking
  Cloud" from the tap on, never "Allowed", until the computer has it. A
  runtime that went to sleep with the ask open drops the answer today: the
  phone says "Your answer didn't arrive. It asks again when it carries on."
- The chat's menu has the two verbs, "Run in Cloud" and "Run on <Mac's
  name>" (`link.ts` `runChoices`): Caveman's own move, as the same chat. One
  that cannot work is not pressable and says why beside it, before anyone
  asks: Cloud lists each chat's `movable` and, when it is false, `stays:
  {code}` (CONTRACT §11). No sentence travels, so `words.ts` words every code
  (`staysWords`), with one plain line for a code it does not know; the phone
  guesses nothing from what else is listed of the chat. A move anyone started
  (`moving`: this phone, another device, Cloud for a message) shows on the
  row and in the chat: "Moving to Cloud… 4s", "Moving to Studio…", or "Moves
  when this turn ends." while it waits for the turn.
- The agents a chat started in chats of their own (`builders.ts`): each row
  is what the computer its lead runs on says became of it
  (`Workspace.builder`): Working, Done, Merged, "Left out: conflicts in
  a.ts", "Paused until 11:08 PM", "Failed: its agent stopped", on the lead's
  rows in the sidebar and in its Agents sheet. The phone says "agents" for
  all of them, never "builders". A
  message the runtime wrote for the agent (`message.done` `generated`) is one
  quiet line, never the person's own bubble: a finished fan-out reads "28 of
  30 merged · 2 left out · PR #128".
- Pull requests to review (`src/pulls/`): with no Mac on line a person reviews
  from Cloud (`/api/v1/code/reviews…`, called with this phone's sign-in). What
  waits on them is where what needs them already is, the sidebar's queue and
  the Needs you list, read as either opens and never in the background; no
  tab was added. A pull request shows its title,
  checks, description, discussion and its files' patches, with Approve,
  Request changes, Comment, Merge when it can be merged, and Ask an agent,
  which starts a chat in Cloud about it.
- A new chat (`start.ts`) picks a project and where it runs: two rows, the
  Mac's name and "Cloud" (which Cloud computer is Caveman's choice). On a Mac
  it is `workspace.create` through the device connection; in Cloud it is
  `POST /code/workspaces` first, as the web does, then `workspace.create` on
  the computer Caveman named, once it is up. The chat is on the board from the
  tap, saying what it waits for; what is typed under it meanwhile is sent once
  it exists. A start Caveman cannot be reached for, or that Cloud has no room
  for ("Cloud is busy. Trying again."), is tried again by itself a few times.
  Cloud makes room by itself at its limits on what runs at once, so a refusal
  there means every computer is working: "Cloud is full on Pro.", the plan's
  name from what one of your computers says of the account.
  If it cannot start, the message stays, marked "Not sent", with the web's one
  line under it ("The chat didn't start: Cloud is busy.") and Try again and
  Discard at the foot; Discard puts the message back in the New chat box, and
  Try again is left out where it cannot work. Where a place cannot be picked
  the Where sheet says why in the web's sentence ("Cloud is off. Ask your
  admin.", "Cloud needs this project on GitHub.").
- A chat runs on what its place runs (`engines.ts`). The model picker lists
  the agents and models the chat's own computer reports (`engine.list`, read
  when it answers and again on `engine.changed`; what it last said stands
  while it sleeps), never the phone's catalog: a Mac's own for a chat on that
  Mac; for Cloud what a Cloud computer of yours last listed, else what one of
  your Macs says your plans and keys run there, else the agents Cloud runs by
  name. An agent that is not offered in Cloud says why under the list
  ("Claude isn't connected for Cloud. Connect it on your Mac (Settings >
  Models & keys)."). A new chat's pick settles on the place its box names, so
  the chip never names a model that place lacks ("No agent" where the place
  has answered and runs none), and again when the place answers at Send; a pick in a chat's own picker goes with its next message
  (`turn.submit` `options`). While a place has listed nothing the picker says
  what it waits for in one line. A Mac is reached for its list before you ask
  only once it has let this phone in.
- Settings lists only what is real on a board that is yours: Account,
  Appearance, Models & keys, Computers, About (`settings/sections.ts`). General,
  Notifications, Chiefs and Caveman MCP set nothing a computer hears yet, so
  they are the scripted world's alone.
- Settings > Computers says the desktop's words: a row per Mac ("Studio · 1
  chat · Asleep") and Cloud as one row ("4 chats · 2 running · 12% of this
  month's plan"), opening to a line per project. Under it, for a Mac that is
  on line and keeps its chats going in Cloud (`settings.get`): "When Studio
  sleeps", with only the chats that will not carry on ("Pauses · Claude isn't
  connected", "Stays on Studio · folder project"), from each chat's `stays`
  code. A Mac gives its own lid summary (`cloud.lid.summary`) only to a window
  on it, so the phone does not read that.
- Settings > Models & keys lists the agents one of your computers reports
  (`engine.list`, a Mac first), one row each with the desktop's one status
  (`settings/models-model.ts`, a port of its `agentStatus`): "Everywhere",
  "Studio only", "Used up until 11:08 PM · now on your Anthropic key",
  "Expires in 5 days", "Expired", "Not signed in", and a sign-in under way on
  a Mac, "Connecting… approve in the browser on Studio". What the phone cannot
  do says "Connect it on your Mac (Settings > Models & keys)." Settings >
  Account shows the plan as percent and reset only.
- The direct path on the same network is the protocol's `connectDirect`,
  already in use: it needs a WebRTC implementation (`direct.rtc`), which on a
  phone is a native module and so a development build. Until then, the relay.
- Not yet: push notifications, photos (your words are sent, the pictures are
  not), a turn's changes, the Chiefs and automations (still scripted, and
  shown only on the scripted board), and the direct path on one network
  (above). Also not yet: a branch to start from, a chat started on a Mac that
  sleeps (nothing queues one; it starts in Cloud), the choice of what a Mac's
  chats do when it sleeps (only its owner sets it, on the Mac), and a
  computer's own Settings for new chats (its default model and permissions).
- Against a test Cloud: `EXPO_PUBLIC_CAVEMAN_CLOUD_URL=http://127.0.0.1:<port>`.
  On the web, `?jscrypto` runs the phone's WebCrypto in place of the browser's.
  `packages/runtime/src/cloudLink/phoneStage.test.ts` holds a stage to look at
  the app on: the stand-in Cloud, a real Mac runtime and two real Cloud
  computer runtimes, with a control port for what a person, Cloud and a Mac's
  lid would do (its header says how to run it). In development,
  `__cc.link.answers(fn)` stands `fn(computer, method, answer)` in for what a
  computer answers a call, to look at a state the stage cannot give.
- Tests: `src/live/*.test.ts` here, and against real runtimes in
  `packages/runtime/src/cloudLink/phoneLive.integration.test.ts` and
  `phone.latency.test.ts`.

## Run it

```bash
pnpm install
pnpm --filter @caveman-app/mobile dev    # scan the QR with Expo Go (SDK 58), same Wi-Fi
pnpm --filter @caveman-app/mobile web    # or in a browser at phone width
```

At 890 by 626 (or 626 by 890) the web build shows the iPhone Duo's inner
screen; at 466 by 678 its outer one.

`web` first copies Skia's CanvasKit (`canvaskit.wasm`) into `public/`;
`index.web.ts` loads it before the app draws.

Expo Go runs the app itself: the photo library, the picker and the camera, and
voice and calls (with the app in front). What iOS shows outside the app needs a
development build, which needs Xcode or EAS: the Live Activity and the widget
(`expo-widgets`), Share to Caveman (`expo-sharing`'s share extension), the quick
actions on the icon (`expo-quick-actions`), and a call that carries on with the
phone locked (background audio). In Expo Go and on the web those parts are off.

```bash
cd apps/mobile
npx expo prebuild --platform ios       # the app, the widget extension, the share extension
npx expo run:ios --device              # or: eas build --profile development --platform ios
```

All three targets share the App Group `group.so.caveman.code`; signing needs a
team that can sign App Groups (a Personal Team can't).

`/?system` on the web build shows every iOS surface at its real size: the Lock
Screen's Live Activity in each mood, the Dynamic Island, the widgets and the quick
actions, drawn from the very layouts the phone runs. In development, `/?share=link`,
`/?share=text` and `/?share=photos` open Share to Caveman with a sample.

## What is where

- `src/store/`: the app's one store (`store.ts`: the board, the inbox and each
  chat's session), its persistence (`persist.ts`, versioned `cc/v1/*` keys over
  `expo-sqlite`'s localStorage on a phone), the selectors every screen counts
  with (`select.ts`: `phaseOf`, tiles, Chiefs, workspaces, devices, lists,
  search), drafts and queues per chat (`sessions.ts`) and where the app opens
  (`launch.ts`). In development it is on `globalThis.__cc`.
- `src/App.tsx`: the providers (appearance, gestures, safe areas), the
  stack and what floats over it. Nothing else.
- `src/nav/`: one native stack with Home at its root (`Navigator.tsx`), its
  routes and params (`routes.ts`: Home, Agents, Workspace, Thread, Chief,
  Review, Automations, Plugins), and the stack from outside a screen
  (`ref.ts`: `openChat`, which pushes a subagent over its parents, and
  `openChief`). It opens on the launch rule's stack and saves every move.
- `src/shell/layout.tsx`: the shell's shape. A phone (and the iPhone Duo
  folded) gets the main panel over the sidebar; where two columns fit (the
  Duo unfolded) the sidebar stands beside the panel, on its side the screen's
  circles stand in the rail at the trailing edge (iOS 27's vertical bar), and
  a chat's Details or a Chief's agents open as a third column, the
  inspector. `DrawerLayout.tsx` draws both shapes; screens fill the rail and
  the inspector through `RailFill` and `InspectorFill`, and size themselves
  by `usePane()`, their own column, not the window.
- `src/shell/`: the chrome every screen shares. The top bar in two shapes
  (`TopBar.tsx`: `pushed`, with Back, the glass title capsule and ···; and
  `home`), the composer (dictation, voice mode and a Chief's call included;
  its bar and menus in `composer/`) and the box that starts a chat
  (`NewChatComposer.tsx`), the bottom sheets with one header (`Sheet.tsx`
  `SheetHeader`: glass X, centred title), Search, the model picker and the
  other choosers (`pickers/`), Settings (`settings/`), a chat's list row
  (`rows/ChatRow.tsx`), what is drawn over the stack (`Overlays.tsx`) and
  the shell's own state, which sheet is up and where a new chat runs
  (`ui.ts`). The drawer and sidebar (`Drawer.tsx`, `Sidebar.tsx`) no longer
  show on a phone; their rows are being moved onto Home and the lists.
- `src/screens/`: each route's screen with its own bar and box: Home, a
  tile's list (`AgentList.tsx`), a workspace, a thread (`ThreadScreen.tsx`
  over `Thread.tsx`), the Chief's board, and Review, Automations and Plugins
  (`Lists.tsx` over `pages/`).
- `src/live/`: what is live. The connection to a real computer ("A real
  computer" above). And the agent's browser and computer, on Session Protocol's
  `browser.*` and `computer.*` (`protocol.ts`, the desktop's LiveSource
  contract mirrored): the live view with the agent's cursor (`LiveScreen.tsx`),
  a view's hold on a screen (`useLive.ts`), and the script's stand-in for the
  runtime (`scripted.ts`) over drawn frames (`pages.ts`, `views.tsx`). A
  chat shows them as pills in its floating row and in its title's long press,
  and opens one on a sheet (`src/thread/Screens.tsx`).
- `src/components/Transcript.tsx`: bubbles, streamed text, the work group, the
  changes and approval cards, the action row; its parts are in
  `components/transcript/`.
- `src/components/ui/`: the desktop's primitives at a finger's size (rows,
  menus and submenus, buttons, badges, fields, empty states, engine logos and
  the model's name, the effort slider). `/?style` on the web build shows them
  all (`StylePage.tsx`).
- `src/screens/Chief.tsx`: a Chief's screen. It decides what the character
  is doing and which card is up, and runs the call. Its parts are in
  `src/chief/`:
  - `Perch.tsx`: the character on the box, with its thought and speech
    bubbles.
  - `Deck.tsx`: the swipe cards.
  - `Strip.tsx`: the chips under the top bar.
  - `ChiefChat.tsx`: the chat with live `[[id]]` titles.
  - `Drop.tsx` and `Work.tsx`: the pull-down work list.
  - `Peek.tsx`: the sheet a chat named on the screen opens as first.
  - `Stage.tsx`: what a call shows.
- `src/components/Sprite.tsx`: the mascot cast's characters and poses, drawn
  in SVG from `@caveman-app/ui/mascot`.
- `src/components/Liquid.tsx`: the Skia shader behind voice mode's orb.
- `src/components/MomentSheet.tsx`: the card that springs up when a chat has
  something to look at, and opens into a sheet.
- `src/components/Pixel.tsx`: the kit's pixel glyphs, engine marks and the
  caveman himself, drawn from `@caveman-app/ui`.
- `src/native/Toggle.ios.tsx`: the system switch through Expo UI (SwiftUI) on
  iOS, tinted the desktop's primary; `Toggle.tsx` draws it for Android and the
  web. The other controls (the segmented control, Allow and Deny, every "…"
  menu) are drawn the desktop's way on every platform, from
  `src/components/ui`.
- `src/system/`: what the phone shows outside the app
  (`docs/`). `glance.ts` words it once for
  every surface; `activity.ts` runs the Live Activity and the widget and answers
  their buttons; `faces.ts` and `png.ts` draw each Chief's face into a picture for
  them; `shortcuts.ts` keeps the icon's quick actions; `share.ts` reads what was
  shared in; `talk.ts` is the conversation out loud and `audio.ts` its session,
  speech and mic level; `preview/` is the `/?system` page.
- `src/widgets/layouts.tsx`: the Live Activity's and the widget's layouts, in Expo
  UI's SwiftUI views, as `'widget'` functions the widget extension runs.
- `src/photos/`: the `+` menu's recent photos and its library page, read a
  page at a time with access asked in context (`library.ts`, `Strip.tsx`), the
  system picker and the camera (`pick.ts`), one picture at a size
  (`Picture.tsx`), the pictures over your words in a message (`Pictures.tsx`)
  and the full-screen viewer (`Viewer.tsx`). The web build has no library, so
  its strip draws the prototype's screenshots (`ShotThumb.tsx`).
- `src/shell/ShareSheet.tsx`: Share to Caveman.
- `src/theme.ts` and `src/motion.ts`: the deck's light and dark tokens, the
  system type scale, and the app's springs and curves.

TypeScript follows the repo's catalog (7.x), not Expo's suggested 6.x, so
`expo install --check` skips it (`expo.install.exclude`).
