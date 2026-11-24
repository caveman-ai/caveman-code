// The side-panel surfaces Smart View adds (a pull request and a page use the panel's own "pr" and "browser"):
//   chat: a full live chat and composer, with the Chief's note on why, one click from opening it in its own tab;
//   media: a picture or a clip, by address or from a chat's checkout (read with the person's own client).
// Registered on import (useSmartView.ts). Neither is in the `+` launcher: a Chief opens them.
import { Icon, Image01Icon, BubbleChatIcon } from "@caveman-app/ui/icons/huge";
import { loadable } from "../lib/loadable.ts";
import { defineSurface } from "../panels/registry.ts";
// A pull request opens in the review surface: registered here too, so Smart View never depends on who imported it first.
import "../routes/review/surface.tsx";

declare module "../panels/store.ts" {
  interface SurfaceParams {
    /** One chat, by its workspace id; `note`: the Chief's line on why it is worth a look. */
    chat: { workspace_id: string; note?: string | undefined };
    /**
     * A picture or a clip: at `url` (http or https), or at `path` in the checkout of chat `workspace_id`. `web`: a page
     * waiting for the person's Load (it then becomes a browser tab). `gate`: an address off this computer, loaded only
     * once the person says so (session-protocol smartView.ts autoLoads).
     */
    media: { media: "image" | "video" | "web"; url?: string | undefined; workspace_id?: string | undefined; path?: string | undefined; gate?: boolean | undefined };
  }
}

defineSurface({
  kind: "chat",
  label: "Chat",
  icon: ({ className }) => <Icon icon={BubbleChatIcon} className={className} />,
  identity: (p) => p.workspace_id,
  title: () => "Chat",
  component: loadable(() => import("./ChatSurface.tsx")),
  keepAlive: true,
  launcher: false,
  // It names its chat, so it shows the same in any panel.
  portable: () => true,
  defaultWidth: "clamp(420px, 46%, 720px)",
});

defineSurface({
  kind: "media",
  label: "Preview",
  icon: ({ className }) => <Icon icon={Image01Icon} className={className} />,
  identity: (p) => p.url ?? `${p.workspace_id ?? ""}:${p.path ?? ""}`,
  title: (tab) => (tab.params.url ?? tab.params.path ?? "").split(/[?#]/)[0]!.split("/").pop() || "Preview",
  component: loadable(() => import("./MediaSurface.tsx")),
  launcher: false,
  // An address, or a file by its chat: the same in any panel.
  portable: () => true,
});
