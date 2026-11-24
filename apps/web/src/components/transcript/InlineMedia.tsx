// Audio or video an answer puts in place (`![take](/tmp/take.mp3)`), played
// where it sits, , apps/web/src/components/
// files/InlineAudioPreview.tsx @ 34e9c56b9b). A file is read from the runtime
// (media.read, which knows audio and video by their bytes) only once the player
// comes near the view, and kept as a blob URL like the chat's images. A video's
// frame can be marked up for the chat's box (annotate/Annotator.tsx), from
// where its player stands.
import { Button } from "@caveman-app/ui/components/button";
import { Icon, Pen01Icon } from "@caveman-app/ui/icons/huge";
import { cn } from "@caveman-app/ui/lib/cn";
import { useEffect, useRef, useState } from "react";
import { imageBlob, mediaName, useImage } from "../../state/media.ts";
import { useRuntimeClient } from "../../state/runtime.tsx";
import { useAnnotate } from "../gallery/Gallery.tsx";

export function InlineMedia({ src, kind, alt, workspaceId, scope }: { src: string; kind: "audio" | "video"; alt: string; workspaceId: string | null; scope: string }) {
  const box = useRef<HTMLSpanElement>(null);
  const [near, setNear] = useState(false);
  useEffect(() => {
    const element = box.current;
    if (!element || near) return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        setNear(true);
        observer.disconnect();
      }
    }, { rootMargin: "200px" });
    observer.observe(element);
    return () => observer.disconnect();
  }, [near]);
  const { state, retry } = useImage(src, workspaceId, scope, near);
  const name = mediaName(src, kind);
  const label = alt || name;
  const { client } = useRuntimeClient();
  const annotate = useAnnotate();
  const player = useRef<HTMLVideoElement>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const markUp = () => {
    player.current?.pause();
    setProblem(null);
    // Its bytes, already read for the player: a frame of them can be drawn into a copy, which a web video's can't.
    imageBlob(client, src, workspaceId, scope).then(
      (blob) => annotate?.({ kind: "video", blob, name, time: player.current?.currentTime ?? 0 }),
      () => setProblem("This video can't be read to mark it up."),
    );
  };
  return (
    <span ref={box} data-slot="inline-media" className="my-2 block w-full max-w-md first:mt-0 last:mb-0">
      {state.status === "ready" ? (
        kind === "audio" ? (
          <audio controls preload="metadata" src={state.url} aria-label={label} className="block h-9 w-full" />
        ) : (
          <video ref={player} controls preload="metadata" src={state.url} aria-label={label} className="block max-h-80 w-full rounded-lg border border-border bg-black" />
        )
      ) : state.status === "error" ? (
        <span role="alert" className="flex h-9 items-center gap-2 rounded-lg border border-border px-3 text-[12.5px] text-muted-foreground">
          <span className="min-w-0 flex-1 truncate">{kind === "audio" ? "Audio" : "Video"} unavailable: {state.message}</span>
          <button type="button" onClick={retry} className="shrink-0 rounded px-1.5 py-0.5 text-foreground outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring">
            Retry
          </button>
        </span>
      ) : (
        <span role="status" aria-label={`Loading ${label}`} className={kind === "audio" ? "block h-9 animate-pulse rounded-full bg-muted" : "block aspect-video w-full animate-pulse rounded-lg bg-muted"} />
      )}
      {/* A video's line is as tall as its button from the start: nothing moves when the video loads. */}
      <span className={cn("mt-1 flex items-center gap-2 text-[12px] leading-4 text-muted-foreground", kind === "video" && annotate && "min-h-6")}>
        <span {...(problem ? { role: "alert" } : {})} className="min-w-0 flex-1 truncate">
          {problem ?? name}
        </span>
        {kind === "video" && annotate && state.status === "ready" ? (
          <Button type="button" variant="ghost" size="sm" onClick={markUp} className="h-6 shrink-0 gap-1 px-1.5 text-[12px]">
            <Icon icon={Pen01Icon} className="size-3.5" />
            Annotate
          </Button>
        ) : null}
      </span>
    </span>
  );
}
