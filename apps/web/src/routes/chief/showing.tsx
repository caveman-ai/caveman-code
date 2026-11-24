// What a piece of work shows of itself (showing-model.ts): its chats' screenshots as a strip of thumbnails that open
// the image viewer, and an Open preview chip per chat that registered one. Under the Chief's message that names the
// work ([[12]], refs.tsx), and on its board row (work.tsx's chip slot, compact).
//
// Open preview asks the runtime to serve the chat's preview (workspace.preview.open: its server, started from the
// chat's worktree on the chat's port, or the one already running) and opens the address in the person's browser.
// The runtime stops the server when it sits idle, when the chat is archived and when the app quits.
import type { ChiefItem } from "@caveman-app/session-protocol";
import { Button } from "@caveman-app/ui/components/button";
import { Popover, PopoverContent, PopoverTrigger } from "@caveman-app/ui/components/popover";
import { Icon, Cancel01Icon, LinkSquare02Icon } from "@caveman-app/ui/icons/huge";
import { PixelIcon, StateMark } from "@caveman-app/ui/icons/PixelIcon";
import { cn } from "@caveman-app/ui/lib/cn";
import { useLayoutEffect, useRef, useState } from "react";
import { ImageStrip, Lightbox, Thumb } from "../../components/gallery/Gallery.tsx";
import { openSoon } from "../../panels/browser/BrowserBar.tsx";
import type { WorkspaceView } from "../../state/model.ts";
import { requestId, useRuntimeClient } from "../../state/runtime.tsx";
import type { ProofImage } from "./showing-model.ts";

type ChipState =
  | { readonly kind: "idle" }
  | { readonly kind: "starting" }
  | { readonly kind: "open"; readonly url: string }
  | { readonly kind: "failed"; readonly message: string };

/** A refusal's words: the runtime's message (a server that exited says why, with the end of its output). */
const messageOf = (error: unknown) =>
  (error as { error?: { message?: string } })?.error?.message ??
  (error instanceof Error ? error.message : "The preview did not start.");

/** Keep the runtime's command summary quiet; stderr remains plain text, with no preflight-specific parsing. */
function PreviewFailure({ message }: { message: string }) {
  const newline = message.indexOf("\n");
  const hasCommandHeader = message.startsWith("`") && newline >= 0;
  const header = hasCommandHeader ? message.slice(0, newline) : "";
  // Split only the runtime's exit header, including commands that themselves contain backticks.
  const exited = /^(.*`) (exited \([^\n]+\) before it listened on port \d+\.)$/.exec(header);
  return (
    <span className="flex min-w-0 max-w-[560px] flex-col gap-1 text-[11.5px] leading-[1.45]">
      {hasCommandHeader ? (
        <span className="flex min-w-0 flex-col text-muted-foreground">
          <span className="truncate" title={exited ? exited[1] : header}>
            {exited ? exited[1] : header}
          </span>
          {exited ? <span className="break-words">{exited[2]}</span> : null}
        </span>
      ) : null}
      <span
        role="status"
        aria-label="Preview failure details"
        tabIndex={0}
        className="max-h-64 overflow-y-auto whitespace-pre-wrap break-words font-mono text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        {hasCommandHeader ? message.slice(newline + 1) : message}
      </span>
    </span>
  );
}

/** Opens a chat's preview in the person's browser, starting its server first when it isn't running. */
export function PreviewChip({
  chat,
  label,
  compact,
}: {
  chat: WorkspaceView;
  label?: string;
  compact?: boolean;
}) {
  const { client } = useRuntimeClient();
  const [state, setState] = useState<ChipState>({ kind: "idle" });
  const button = useRef<HTMLButtonElement>(null);
  const failure = useRef<HTMLDivElement>(null);
  const replacingFocus = useRef<Element | null>(null);
  const changeState = (next: ChipState) => {
    const active = document.activeElement;
    replacingFocus.current =
      active && (button.current?.contains(active) || failure.current?.contains(active))
        ? active
        : null;
    setState(next);
  };
  useLayoutEffect(() => {
    const previous = replacingFocus.current;
    replacingFocus.current = null;
    // Preserve local focus only when this transition removed its owner. A person who moved away wins.
    if (previous && !previous.isConnected && document.activeElement === document.body) {
      button.current?.focus();
    }
  });
  if (!chat.preview) return null;
  const open = () => {
    if (!client || state.kind === "starting") return;
    // In a browser the tab opens inside the click, else it is blocked; it is pointed at the page once it serves.
    const go = openSoon();
    changeState({ kind: "starting" });
    client
      .call("workspace.preview.open", { request_id: requestId(), workspace_id: chat.id })
      .then(({ url }) => {
        go(url);
        changeState({ kind: "open", url });
      })
      .catch((error: unknown) => {
        go(null);
        changeState({ kind: "failed", message: messageOf(error) });
      });
  };
  const stop = () => {
    changeState({ kind: "idle" });
    void client
      ?.call("workspace.preview.stop", { request_id: requestId(), workspace_id: chat.id })
      .catch(() => undefined);
  };
  const title = `${label ? `${label}: ` : ""}runs \`${chat.preview.command}\` in this chat's checkout and opens ${chat.preview.path} in your browser`;
  if (compact && state.kind === "failed")
    return (
      <Popover>
        <PopoverTrigger asChild>
          <Button
            ref={button}
            variant="secondary"
            size="icon-sm"
            aria-label={
              label ? `Preview failed for ${label}: show details` : "Preview failed: show details"
            }
            title="Preview failed: show details"
            className="size-[22px] rounded-md text-warning"
            onClick={(e) => e.stopPropagation()}
          >
            <PixelIcon name="state-failed" />
          </Button>
        </PopoverTrigger>
        <PopoverContent
          ref={failure}
          align="end"
          aria-label="Preview failed"
          className="w-[560px] max-w-[calc(100vw-24px)] space-y-2 p-3"
          onClick={(e) => e.stopPropagation()}
          onContextMenu={(e) => e.stopPropagation()}
          onPointerDown={(e) => e.stopPropagation()}
          onDragStart={(e) => e.stopPropagation()}
        >
          <p className="text-[13px] font-medium">Preview failed</p>
          <PreviewFailure message={state.message} />
          <Button variant="secondary" size="sm" onClick={open}>
            Retry
          </Button>
        </PopoverContent>
      </Popover>
    );
  return (
    <span className="inline-flex min-w-0 max-w-full flex-col gap-1">
      <span className="inline-flex items-center gap-0.5">
        <Button
          ref={button}
          variant="secondary"
          size={compact ? "icon-sm" : "sm"}
          onClick={(e) => {
            e.stopPropagation();
            open();
          }}
          title={state.kind === "failed" ? state.message : title}
          aria-label={
            state.kind === "failed"
              ? label
                ? `Preview failed for ${label}: retry`
                : "Preview failed: retry"
              : label
                ? `Open preview of ${label}`
                : "Open preview"
          }
          className={cn(
            "gap-1.5",
            compact && "size-[22px] rounded-md",
            state.kind === "failed" && "text-warning",
          )}
        >
          {state.kind === "starting" ? (
            <span className="inline-grid size-3.5 place-items-center">
              <StateMark name="state-working" animate />
            </span>
          ) : (
            <Icon icon={LinkSquare02Icon} className="size-3.5" />
          )}
          {compact
            ? null
            : state.kind === "starting"
              ? "Starting…"
              : state.kind === "failed"
                ? "Preview failed"
                : label
                  ? `Open preview · ${label}`
                  : "Open preview"}
        </Button>
        {state.kind === "open" ? (
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={(e) => {
              e.stopPropagation();
              stop();
            }}
            title="Stop the preview server"
            aria-label="Stop the preview server"
            className={cn(compact && "size-[22px]")}
          >
            <Icon icon={Cancel01Icon} className="size-3" />
          </Button>
        ) : null}
      </span>
      {state.kind === "failed" && !compact ? <PreviewFailure message={state.message} /> : null}
    </span>
  );
}

/** Screenshots that open the viewer over just these, read with the Chief's workspace (media.read). */
export function ProofStrip({
  images,
  workspaceId,
  className,
}: {
  images: ReadonlyArray<ProofImage>;
  workspaceId: string | null;
  className?: string;
}) {
  const [viewing, setViewing] = useState<string | null>(null);
  if (images.length === 0) return null;
  return (
    <>
      <ImageStrip
        images={images}
        workspaceId={workspaceId}
        onOpen={setViewing}
        {...(className ? { className } : {})}
      />
      <Lightbox
        images={images}
        openId={viewing}
        workspaceId={workspaceId}
        onSelect={setViewing}
        onClose={() => setViewing(null)}
      />
    </>
  );
}

/** Under a Chief message: each piece of work it names that has something to show, its screenshots then its chips. */
export function WorkShowing({
  shown,
  chiefWorkspaceId,
}: {
  shown: ReadonlyArray<{
    readonly key: string;
    readonly item: ChiefItem;
    readonly images: ReadonlyArray<ProofImage>;
    readonly previews: ReadonlyArray<WorkspaceView>;
  }>;
  chiefWorkspaceId: string | null;
}) {
  if (shown.length === 0) return null;
  return (
    <div className="mt-1.5 flex flex-col gap-2">
      {shown.map(({ key, images, previews }) => (
        <div key={key} className="flex flex-col gap-1.5">
          <ProofStrip images={images} workspaceId={chiefWorkspaceId} />
          {previews.length > 0 ? (
            <div className="flex flex-wrap items-start gap-1.5">
              {previews.map((chat) => (
                <PreviewChip
                  key={chat.id}
                  chat={chat}
                  {...(previews.length > 1 || shown.length > 1 ? { label: chat.title } : {})}
                />
              ))}
            </div>
          ) : null}
        </div>
      ))}
    </div>
  );
}

/** A board row's slot (work.tsx): its first screenshot small (+N for the rest), then a Preview chip; the row's title keeps its room. Clicks never open the row. */
export function WorkRowShowing({
  images,
  previews,
  chiefWorkspaceId,
}: {
  images: ReadonlyArray<ProofImage>;
  previews: ReadonlyArray<WorkspaceView>;
  chiefWorkspaceId: string | null;
}) {
  const [viewing, setViewing] = useState<string | null>(null);
  if (images.length === 0 && previews.length === 0) return null;
  const shown = images.slice(0, 1);
  return (
    <span className="inline-flex shrink-0 items-center gap-1" onClick={(e) => e.stopPropagation()}>
      {shown.map((image, i) => (
        <button
          key={image.id}
          type="button"
          onClick={() => setViewing(image.id)}
          title={image.title}
          aria-label={
            i === shown.length - 1 && images.length > shown.length
              ? `Open screenshot: ${image.title}, and ${images.length - shown.length} more`
              : `Open screenshot: ${image.title}`
          }
          className="relative size-[22px] overflow-hidden rounded-[5px] border border-border bg-muted outline-none transition-colors duration-75 hover:border-input focus-visible:ring-2 focus-visible:ring-ring"
        >
          <Thumb image={image} workspaceId={chiefWorkspaceId} />
          {i === shown.length - 1 && images.length > shown.length ? (
            <span
              aria-hidden
              className="absolute inset-0 grid place-items-center bg-black/55 text-[10px] font-medium tabular-nums text-white"
            >
              +{images.length - shown.length}
            </span>
          ) : null}
        </button>
      ))}
      {previews.map((chat) => (
        <PreviewChip
          key={chat.id}
          chat={chat}
          compact
          {...(previews.length > 1 ? { label: chat.title } : {})}
        />
      ))}
      <Lightbox
        images={images}
        openId={viewing}
        workspaceId={chiefWorkspaceId}
        onSelect={setViewing}
        onClose={() => setViewing(null)}
      />
    </span>
  );
}
