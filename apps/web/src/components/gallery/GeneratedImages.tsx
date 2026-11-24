// Generated artwork stays visible when the turn's tools fold away. The image opens the same
// T3-style viewer as attachments/screenshots, with paging, zoom, copy, save and focus return.
import { cn } from "@caveman-app/ui/lib/cn";
import { Icon, ArrowExpand01Icon, Download04Icon, RefreshCwIcon, Image01Icon } from "@caveman-app/ui/icons/huge";
import { useState } from "react";
import { imagePrompt, isImageGeneration, record } from "../../state/image-generation.ts";
import { mediaRef, useImage } from "../../state/media.ts";
import { useRuntimeClient } from "../../state/runtime.tsx";
import type { Artifact, ToolItem } from "../../state/transcript-model.ts";
import { useChatWorkspace } from "../transcript/root.ts";
import { downloadImage } from "./actions.ts";
import { isImage, useOpenImage, type ImageArtifact } from "./Gallery.tsx";

export function GeneratedImages({ tools, artifacts }: { tools: ReadonlyArray<ToolItem>; artifacts: ReadonlyArray<Artifact> }) {
  return tools.filter((tool) => isImageGeneration(tool.name)).map((tool) => {
    const images = artifacts.filter((a): a is ImageArtifact => a.itemId === tool.id && isImage(a));
    const prompt = imagePrompt(tool);
    return (
      <div key={tool.id} className="my-2 flex max-w-full flex-wrap gap-3" data-image-generation={tool.status}>
        {images.length ? images.map((image) => <GeneratedImage key={image.id} image={image} prompt={prompt} transparent={record(tool.result).transparent_background === true} />) : (
          <div role="status" aria-live="polite" className={cn("flex w-[360px] max-w-full flex-col items-center justify-center gap-2 rounded-xl border border-border bg-card px-5 py-8 text-center", tool.status === "running" && "min-h-60")}>
            <Icon icon={Image01Icon} className={cn("mb-1 size-4 text-muted-foreground", tool.status === "running" && "animate-pulse motion-reduce:animate-none")} />
            <span className="text-[13px] font-medium">{tool.status === "running" ? "Generating image" : tool.status === "denied" ? "Image generation cancelled" : tool.status === "done" ? "Generated image isn't available" : "Image wasn't generated"}</span>
            <p className="max-w-full whitespace-pre-wrap break-words text-[12px] leading-5 text-muted-foreground">{tool.status === "running" ? "This may take a moment." : tool.output.trim() || "No image was returned. Ask the agent to try again."}</p>
          </div>
        )}
      </div>
    );
  });
}

const actionClass = "inline-flex h-7 items-center gap-1.5 rounded-md px-2 text-[12px] text-muted-foreground outline-none transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50";

function GeneratedImage({ image, prompt, transparent }: { image: ImageArtifact; prompt: string | null; transparent: boolean }) {
  const workspaceId = useChatWorkspace();
  const { client } = useRuntimeClient();
  const open = useOpenImage();
  const { state, retry } = useImage(image.src ?? "", workspaceId, image.itemId);
  const [broken, setBroken] = useState(false);
  const [size, setSize] = useState<readonly [number, number] | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const failed = state.status === "error" || broken;
  const save = async () => {
    setSaving(true);
    setError(null);
    try { await downloadImage(client, { src: image.src!, name: "generated-image.png", workspaceId, scope: image.itemId }); }
    catch (e) { setError(e instanceof Error ? e.message : "The image couldn't be saved."); }
    finally { setSaving(false); }
  };
  return (
    <figure className="m-0 w-[360px] min-w-0 max-w-full overflow-hidden rounded-xl border border-border bg-card">
      <div className="relative grid aspect-square place-items-center bg-[repeating-conic-gradient(hsl(var(--muted))_0%_25%,transparent_0%_50%)] bg-[length:16px_16px]">
        {failed ? (
          <div role="alert" className="flex flex-col items-center gap-3 px-5 text-center text-[12px] text-muted-foreground">
            <span>{state.status === "error" ? state.message : "The image couldn't be displayed."}</span>
            <button type="button" className={actionClass} onClick={() => { setBroken(false); if ((mediaRef(image.src ?? "")?.kind ?? "url") !== "url") retry(); }}><Icon icon={RefreshCwIcon} size={13} /> Try loading again</button>
          </div>
        ) : state.status === "ready" ? (
          <button type="button" disabled={!open} aria-label={`Open image: ${image.title}`} onClick={() => open?.(image.id)} className="absolute inset-0 grid place-items-center outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring">
            <img src={state.url} alt={prompt ?? image.alt ?? image.title} referrerPolicy="no-referrer" className="size-full object-contain" onLoad={(e) => setSize([e.currentTarget.naturalWidth, e.currentTarget.naturalHeight])} onError={() => setBroken(true)} />
          </button>
        ) : <span role="status" className="text-[12px] text-muted-foreground">Loading image…</span>}
      </div>
      <figcaption className="border-t border-border px-3 pb-2 pt-2.5">
        <div className="flex min-w-0 items-center justify-between gap-2">
          <span className="truncate text-[12px] font-medium">{image.title}</span>
          <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">{size ? `${size[0]} × ${size[1]}` : ""}{transparent ? " · Transparent" : ""}</span>
        </div>
        {prompt ? <details className="mt-1 text-[12px] text-muted-foreground"><summary className="cursor-pointer rounded-sm py-1 outline-none focus-visible:ring-2 focus-visible:ring-ring">Prompt</summary><p className="mt-1 whitespace-pre-wrap break-words pb-1 leading-5">{prompt}</p></details> : null}
        <div className="-mx-1 mt-1 flex items-center gap-1">
          <button type="button" className={actionClass} disabled={saving || failed || state.status !== "ready"} onClick={() => void save()}><Icon icon={Download04Icon} size={13} />{saving ? "Saving…" : "Save image"}</button>
          <button type="button" className={actionClass} disabled={!open || failed || state.status !== "ready"} onClick={() => open?.(image.id)}><Icon icon={ArrowExpand01Icon} size={13} /> Expand</button>
        </div>
        {error ? <p role="alert" className="mt-1 break-words text-[12px] text-destructive">{error}</p> : null}
      </figcaption>
    </figure>
  );
}
