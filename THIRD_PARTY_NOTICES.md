# Third-party notices

Caveman Code is licensed under the Apache License, Version 2.0 (see `LICENSE`
and `NOTICE`). It builds upon and ports selected modules from the open-source
projects below under their respective licenses, pinned at the commits named. It
also redistributes, unmodified, the Caveman binaries and `agent-desktop` named
below.

## T3 Code

Source: https://github.com/pingdotgg/t3code (MIT License), initially ported at
`ab3a3cd1`, updated through `13aa882c22` (2026-10-17), `29f33af7d7`
(2026-10-28), and `67eebaca23` (2026-11-05 / 2026-11-09).

Derived and ported modules include portions of the Electron desktop shell and
updater (`apps/desktop/src/updates/`, `startupRecovery.ts`,
`serverCompileCache.ts`, `scripts/profile-startup.mjs`,
`scripts/mock-update-server.mjs`), web client and browser test harness
(`apps/web/test/browser-setup.ts`, `apps/web/vitest.browser.config.ts`),
provider and source-control adapters (`packages/provider-*`,
`packages/source-control-*`, `packages/engine-core`, `packages/protocol`,
`packages/shared`, `packages/runtime`), math/table markdown patches
(`patches/`), and lint rules (`oxlint-plugin-caveman/`).
All T3 Code-derived portions remain subject to the MIT License notice below,
which travels with both source and binary distributions (`LICENSE`, `NOTICE`,
and `THIRD_PARTY_NOTICES.md`).

Conversation scroll ownership in `packages/ui/src/ai/conversation-scroll.ts`
is ported from `apps/web/src/components/chat/timelineScrollTarget.ts` at 13aa882c22.

The artifact-template result cards and composer prompt interaction are adapted
from `apps/web/src/components/ChatMarkdown.tsx` and `ChatView.logic.ts` at
13aa882c22, using the already-ported shared `codexArtifactTemplates.ts` helpers.
Generated images reuse the ported ExpandedImageDialog interaction; native Codex
imageGeneration event normalization and its generation-state cards are new
Caveman Code implementation, not copied T3 code.

The web app's browser tests follow T3's browser project at 67eebaca23: the
pointer reset in `apps/web/test/browser-setup.ts` and
`apps/web/vitest.browser.config.ts` is adapted from `apps/web/test/browserSetup.ts`
and `apps/web/vite.config.ts`, and CI's Chromium cache steps from
`.github/workflows/ci.yml`. The scripted Session Protocol runtime they run
against (`apps/web/test`) is new Caveman Code implementation.

```
MIT License

Copyright (c) 2026 T3 Tools Inc.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## MonoCode

Source: https://github.com/hardbeat920/monocode at 26465c6 (2026-10-23). The
chat's streaming mechanisms are ported from it and restyled onto the deck:
the paced word reveal and word fade (`packages/ui/src/ai/word-fade.ts`, from
`src/features/sessions/ui/wordFade.tsx`), the tool-step entrance queue and the
live run window (`apps/web/src/components/transcript/WorkRun.tsx`, from
`AgentTranscript.tsx`), and their keyframes (`packages/ui/src/styles/stream.css`,
from `src/styles/index.css`). Ported 2026-10-25: the prompt rise and turn reveal
(`apps/web/src/components/Transcript.tsx` usePromptRise, from
`AgentTranscript.tsx`), the selection menu
(`apps/web/src/components/transcript/QuoteSelection.tsx`, from
`TranscriptSelectionMenu.tsx`), the copy mark (`packages/ui/src/ai/code-block.tsx`
and `src/styles/markdown.css`, from `AgentMarkdown.tsx` and `index.css`), the
folding tab (`apps/web/src/panels/SidePanel.tsx`, from
`src/features/monos/ui/MonoOverview.tsx`), the name-pill header
(`apps/web/src/routes/Chief.tsx` ChiefHeader, from `MonoHeader.tsx`), the
diff palette and row treatment (`packages/ui/src/styles/globals.css` --diff-*,
`apps/web/src/panels/diff/FileDiff.tsx`, from `index.css` and
`UnifiedDiffView.tsx`), and the chat prose measure
(`packages/ui/src/ai/response.tsx`, from `AgentMarkdown.tsx` and `index.css`).

```
MIT License

Copyright (c) 2026 Nick

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## Pierre trees

`@pierre/trees` 1.0.0-beta.6, Apache License 2.0
(https://www.apache.org/licenses/LICENSE-2.0). The app ships its file-type
icon resolver and icon sprite (`packages/ui/src/icons/file-type.tsx`). Its
NOTICE:

This project includes some code derived from
[@headless-tree/core](https://github.com/lukasbach/headless-tree).

The initial version of this project used `headless-tree` as the underlying tree
implementation. We have since written our own core at `packages/path-store`, but
many of the best ideas from `headless-tree` made their way to `path-store` and
`trees`. It's hard to identify exactly which code this is at this point, but
definitely things like the drag and drop implementation and the general list
approach to rendering and I'm sure more. The work that `@lukasbach` has
contributed to this space is greatly appreciated. `<3`

Original license for `headless-tree/core`:

```
MIT License

Copyright (c) 2023 Lukas Bach

Permission is hereby granted, free of charge, to any person obtaining a copy of
this software and associated documentation files (the "Software"), to deal in
the Software without restriction, including without limitation the rights to
use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of
the Software, and to permit persons to whom the Software is furnished to do so,
subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS
FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR
COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER
IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN
CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
```

The extra file-type marks that file carries from T3 Code are language logos
from Simple Icons (CC0 1.0) and two Lucide icons (ISC), drawn inline in its sprite.

## Hugeicons

Source: https://github.com/hugeicons (`@hugeicons/core-free-icons` 4.3.5 and
`@hugeicons/react` 1.1.10, both MIT). The app's chrome icons
(`packages/ui/src/icons/huge.tsx`) are its free line set, bundled into the client.

```
MIT License

Copyright (c) 2025 Hugeicons

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## Matt Pocock's skills

Source: https://github.com/mattpocock/skills, plugin version 1.2.3. Grill
mode's skill (`packages/runtime/src/grill/grill-plugin/skills/grill/SKILL.md`)
is adapted from its `grilling` skill.

```
MIT License

Copyright (c) 2026 Matt Pocock

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## Catalog logos

`catalog/plugins/*/assets` holds vendor marks, used only to name each vendor's
service; trademarks belong to their owners. Sources and licences per logo are
in `catalog/README.md`: simple-icons 16.35.0 (CC0-1.0), Playwright's logo from
microsoft/playwright (Apache-2.0), and Context7's icon from upstash/context7:

```
The MIT License (MIT)

Copyright (c) 2021 Upstash, Inc.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## node-datachannel and libdatachannel

The runtime opens the direct path to a person's devices (WebRTC data
channels, `packages/runtime/src/cloudLink/direct.ts`) with node-datachannel
0.33.4 (https://github.com/murat-dogan/node-datachannel), used unmodified as an
npm dependency with its prebuilt `@node-datachannel/<platform>` native module.
node-datachannel and the libdatachannel 0.24.5 it statically links
(https://github.com/paullouisageneau/libdatachannel, with libjuice) are
licensed under the Mozilla Public License, Version 2.0
(https://mozilla.org/MPL/2.0/); their source is at the links above, and the
license text ships in the package (`node_modules/node-datachannel/LICENSE`).
The native module also links usrsctp and libsrtp 2.8.0 (BSD 3-Clause),
plog (MIT) and OpenSSL (Apache License 2.0), each under its own license.

## Caveman (caveman-proxy, caveman-mcp, caveman-engine)

Source: https://github.com/JuliusBrussee/caveman, the `bin-v*` binary release
`packages/runtime/scripts/cavemanBinaries.ts` pins (its tag is in
`runtime/bin/licenses/RELEASE`). The desktop app and a
Cloud computer's runtime carry `caveman-proxy`, `caveman-mcp` and
`caveman-engine` unmodified in `runtime/bin/`, and the `@caveman-ai/code` npm
package in `bin/`. Copyright 2026 Julius Brussee, licensed under the Apache
License, Version 2.0. The license text, the release's NOTICE (with the MIT
text, pixel-engine and font notices it names) and the license texts of the Go
modules the binaries link (`THIRD_PARTY_GO_LICENSES.tar.gz`) ship beside them
in `bin/licenses/` there.

## agent-desktop

Source: https://github.com/vercel-labs/agent-desktop, the npm release
`packages/runtime/scripts/agentDesktopBinary.ts` pins (its version is in
`runtime/bin/licenses/agent-desktop/RELEASE`). The macOS desktop app carries
`agent-desktop` and `agent-desktop-macos-helper` unmodified in `runtime/bin/`
for computer use on a Mac. A Vercel Labs project, licensed under the Apache
License, Version 2.0; the license text ships beside them in
`bin/licenses/agent-desktop/LICENSE`.

## Ask classifier training data

The runtime's task classifier (`packages/runtime/src/askModel/`) ships Caveman
Cloud's ask model `ask_r4` unmodified in `model/`. The model holds hashed
buckets and numbers only, no text of its training data: human-typed asks from
public Hugging Face datasets of coding-agent sessions, each under a named
licence (`model/MODEL_CARD.md` lists them all). It was trained on data
licensed under the Open Data Commons Attribution License
(https://opendatacommons.org/licenses/by/1-0/, ODC-BY) and Creative Commons
Attribution 4.0 (https://creativecommons.org/licenses/by/4.0/, CC BY 4.0):

- SWE-chat, SALT-NLP (arXiv 2604.20779; `SALT-NLP/SWE-chat` and its mirror
  `cfahlgren1/SWE-chat`). ODC-BY.
- `submit2331/ACT-2.5B`. ODC-BY.
- `nmuendler/share-codex`. CC BY 4.0.
- `trace-commons/agent-traces`. CC BY 4.0.
- `AlinCiocan/fable-5-claude-code-traces`. CC BY 4.0.
- `julien-c/pi-sessions`. CC BY 4.0.

and on MIT-licensed session exports by individual developers, the largest
`zhiyaowang/dataclaw-zhiyaowang`, `peteromallet/my-dataclaw-data`,
`peteromallet/dataclaw-peteromallet`, `Petrouil/opencode-agentic-mini`,
`woctordho/dataclaw` and `woctordho/dataclaw-windows`. Each dataset is at
`https://huggingface.co/datasets/<name>`. No endorsement by the data's authors
is implied.


## Super Visuals wallpapers

Artwork: Ahmed Hassan (@supervisuals), **Super Visuals**.

- Creator: https://www.figma.com/@supervisuals
- Community source: https://www.figma.com/community/file/1626392436817658229/super-visuals-50-stunning-backgrounds-v1
- Source design: https://www.figma.com/design/1RjQY50dy7t9SucZtAIb1p/
- License: Creative Commons Attribution 4.0 International (CC BY 4.0)
- License link: https://creativecommons.org/licenses/by/4.0/

Caveman encoded these 35 images as WebP, preserving native dimensions, and
created cropped 640 × 400 thumbnails. Color palettes and app previews were
created by Caveman. No endorsement by the artwork creator is implied.
Original image hashes and checksums appear in sources.json.

CC BY 4.0 permits sharing and adaptation, including commercial use, with
appropriate credit, a license link, and indication of changes. No additional
restrictions are imposed on the artwork by Caveman's software license.


## Night wallpaper collection

These artworks are delivered on demand from Caveman’s wallpaper library.
Caveman resized and encoded images as WebP and cropped gallery thumbnails.
Credits, source pages, and individual licenses:

- **River at Midnight** — Aert van der Neer. [Public domain](https://creativecommons.org/publicdomain/mark/1.0/); [source](https://commons.wikimedia.org/wiki/File:Aert_van_der_Neer_-_Night_Landscape_with_a_River_-_WGA16489.jpg).
- **Moonlit Countryside** — Feliks Brzozowski. [Public domain](https://creativecommons.org/publicdomain/mark/1.0/); [source](https://commons.wikimedia.org/wiki/File:Feliks_Brzozowski_-_Countryside_landscape_at_night_-_MP_2328_MNW_-_National_Museum_in_Warsaw.jpg).
- **Kuindzhi Night** — Arkhip Kuindzhi. [Public domain](https://creativecommons.org/publicdomain/mark/1.0/); [source](https://commons.wikimedia.org/wiki/File:Kuindzhi_Night_landscape.jpg).
- **Night Study** — László Mednyánszky. [Public domain](https://creativecommons.org/publicdomain/mark/1.0/); [source](https://commons.wikimedia.org/wiki/File:Ladislav_Medny%C3%A1nszky_-_Study_of_a_Night_Landscape_-_O_5022_-_Slovak_National_Gallery.jpg).
- **Moonrise over Sea** — Caspar David Friedrich. [Public domain](https://creativecommons.org/publicdomain/mark/1.0/); [source](https://commons.wikimedia.org/wiki/File:Caspar_David_Friedrich_-_Mondaufgang_am_Meer_-_Google_Art_Project.jpg).
- **Starry Night** — Vincent van Gogh. [Public domain](https://creativecommons.org/publicdomain/mark/1.0/); [source](https://commons.wikimedia.org/wiki/File:Vincent_van_Gogh_-_Starry_Night_-_Google_Art_Project.jpg).
- **Southern Sky** — ESO/H.H. Heyer. [CC BY 4.0](https://creativecommons.org/licenses/by/4.0); [source](https://commons.wikimedia.org/wiki/File:360-degree_Panorama_of_the_Southern_Sky.jpg).
- **Atacama Night** — ESO. [CC BY 4.0](https://creativecommons.org/licenses/by/4.0); [source](https://commons.wikimedia.org/wiki/File:AT4_under_the_night_sky_(eso-paranal-lv3).jpg).
- **California Nebula** — Joshua Tree National Park. [Public domain](https://creativecommons.org/publicdomain/mark/1.0/); [source](https://commons.wikimedia.org/wiki/File:California_Nebula_(55209560382).jpg).
- **Crab Nebula** — Taavi Niittee/Tõrva Astronoomiaklubi/Tõrva Astronomy Club. [CC BY 4.0](https://creativecommons.org/licenses/by/4.0); [source](https://commons.wikimedia.org/wiki/File:Crab_nebula_from_T%C3%B5rva.jpg).
- **Trifid Nebula** — NASA, ESA, and The Hubble Heritage Team (AURA/STScI ). [Public domain](https://creativecommons.org/publicdomain/mark/1.0/); [source](https://commons.wikimedia.org/wiki/File:Full_HST_WFPC2_image_of_Trifid_Nebula_(opo0417g).jpg).
- **Rosette Nebula** — Joshua Tree National Park. [Public domain](https://creativecommons.org/publicdomain/mark/1.0/); [source](https://commons.wikimedia.org/wiki/File:Rosette_Nebula_(55224917056).jpg).
- **Cygnus Veil** — NASA/JPL-Caltech. [Public domain](https://creativecommons.org/publicdomain/mark/1.0/); [source](https://commons.wikimedia.org/wiki/File:Ultraviolet_image_of_the_Cygnus_Loop_Nebula_crop.jpg).
- **Carina Nebula** — ESO/S. Brunier. [CC BY 4.0](https://creativecommons.org/licenses/by/4.0); [source](https://commons.wikimedia.org/wiki/File:The_Carina_Nebula_(b08).jpg).
- **Cachuma after Dark** — Derek Petersen. [CC BY 3.0](https://creativecommons.org/licenses/by/3.0); [source](https://commons.wikimedia.org/wiki/File:Lake_Cachuma_At_Night_(26948891).jpeg).
- **Red Mountain Night** — John Fowler from Placitas, NM, USA. [CC BY 2.0](https://creativecommons.org/licenses/by/2.0); [source](https://commons.wikimedia.org/wiki/File:Red_Mountain_at_Night_-_Flickr_-_snowpeak.jpg).
- **Steens Starlight** — Bureau of Land Management. [Public domain](https://creativecommons.org/publicdomain/mark/1.0/); [source](https://commons.wikimedia.org/wiki/File:Steens_Mountain_in_eastern_Oregon_(9683731272).jpg).
- **Aurora over Earth** — NASA. [Public domain](https://www.nasa.gov/nasa-brand-center/images-and-media/); [source](https://images.nasa.gov/details/iss073e0293986).
- **Atmospheric Glow** — NASA. [Public domain](https://www.nasa.gov/nasa-brand-center/images-and-media/); [source](https://images.nasa.gov/details/iss073e0035898).
- **Milky Way Horizon** — NASA. [Public domain](https://www.nasa.gov/nasa-brand-center/images-and-media/); [source](https://images.nasa.gov/details/iss073e0982823).

No creator endorsement is implied. The software license imposes no additional
restrictions on this artwork. Full metadata and content hashes are recorded in
`apps/web/src/state/wallpaper-library.json`.
