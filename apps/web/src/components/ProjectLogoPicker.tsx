// A project's logo, picked: the images the runtime finds in the checkout (project.logo.candidates) as tiles with the
// logo now pressed, an image of the person's own, Automatic (what the runtime finds) and No logo (the folder), each
// pressed while it is on. A pick is drawn small here and kept by the runtime (project.update `logo`). The project's ⋯
// menu opens it in a dialog (ProjectLogoDialog); the Chief's editor shows it inline.
import { SessionProtocolError } from "@caveman-app/session-protocol/client";
import { Button } from "@caveman-app/ui/components/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@caveman-app/ui/components/dialog";
import { cn } from "@caveman-app/ui/lib/cn";
import { useEffect, useRef, useState } from "react";
import type { ProjectLogoView } from "../state/model.ts";
import { rememberLogo } from "../state/project-logos.ts";
import { requestId, useRuntimeClient, useRuntimeSelector } from "../state/runtime.tsx";

/** Project.logo's rule, the plugin logos' one. */
const LOGO_MAX_BYTES = 64 * 1024;
/** A pick's square: 16px at 4x, and the board's 20px. */
const SIZE = 64;
/** A file bigger than this is refused before it is read. */
const UPLOAD_MAX_BYTES = 10 * 1024 * 1024;
const ACCEPT =
  "image/png,image/svg+xml,image/jpeg,image/webp,image/gif,image/x-icon,.png,.svg,.jpg,.jpeg,.webp,.gif,.ico";
const OUTDATED = "The runtime on this computer needs an update to keep a logo.";

interface Candidate {
  readonly path?: string;
  readonly url: string;
  readonly source: "favicon" | "file" | "owner";
  readonly current?: true;
}
type Choice = "auto" | "none" | { readonly url: string; readonly path?: string };
interface Project {
  readonly id: string;
  readonly name: string;
  readonly logo?: ProjectLogoView;
  readonly logoMode?: "none" | "picked";
}
/** An image ready to draw, and what to let go of once it is drawn. */
interface Decoded {
  readonly image: CanvasImageSource;
  readonly width: number;
  readonly height: number;
  readonly done: () => void;
}

/** `src` (a data: or object URL) as an <img>: SVG too, which createImageBitmap does not decode. */
async function imageAt(src: string, done: () => void): Promise<Decoded> {
  const image = new Image();
  image.src = src;
  try {
    await image.decode();
  } catch {
    done();
    throw new Error("That file isn't an image this browser can draw");
  }
  // An SVG with no size of its own reads as 0x0: it fills the square.
  return { image, width: image.naturalWidth || SIZE, height: image.naturalHeight || SIZE, done };
}

/** A chosen file, decoded without reading it whole into a data: URL: createImageBitmap, else an <img> on an object URL. */
async function decodeFile(file: Blob): Promise<Decoded> {
  try {
    const bitmap = await createImageBitmap(file);
    return {
      image: bitmap,
      width: bitmap.width,
      height: bitmap.height,
      done: () => bitmap.close(),
    };
  } catch {
    const src = URL.createObjectURL(file);
    return imageAt(src, () => URL.revokeObjectURL(src));
  }
}

/** An image drawn into a 64px square, contain-fit, as a PNG data: URL of at most 64 KiB. */
async function drawLogo(decoded: Decoded): Promise<string> {
  try {
    const canvas = document.createElement("canvas");
    canvas.width = SIZE;
    canvas.height = SIZE;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("This browser can't draw the image");
    const scale = Math.min(SIZE / decoded.width, SIZE / decoded.height);
    // A small pixel favicon grows crisp, not blurred.
    context.imageSmoothingEnabled = scale < 1;
    context.imageSmoothingQuality = "high";
    const width = decoded.width * scale;
    const height = decoded.height * scale;
    context.drawImage(decoded.image, (SIZE - width) / 2, (SIZE - height) / 2, width, height);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
    if (!blob || blob.size > LOGO_MAX_BYTES)
      throw new Error("That image is too detailed to keep as a logo");
    return await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(reader.error ?? new Error("Could not read the image"));
      reader.readAsDataURL(blob);
    });
  } finally {
    decoded.done();
  }
}

const message = (e: unknown) =>
  e instanceof SessionProtocolError ? e.error.message : e instanceof Error ? e.message : String(e);
/** A runtime from before logos: it has no candidates, and its project.update drops `logo` without a word. */
const outdatedRuntime = (e: unknown) =>
  e instanceof SessionProtocolError &&
  (e.error.code === -32601 || e.error.data?.reason === "unsupported");

/**
 * The picker itself: the checkout's images as 48px tiles (the logo now pressed), then Choose image…, No logo and
 * Automatic (pressed while on). Every control is a plain button with aria-pressed. `onSaved` runs once the runtime has
 * the new logo.
 */
export function ProjectLogoPicker({
  project,
  onSaved,
  className,
}: {
  project: Project;
  onSaved?: () => void;
  className?: string;
}) {
  const { client } = useRuntimeClient();
  const refresh = useRuntimeSelector((v) => v.refresh);
  // The runtime's answer, with the project it is for: another project's shows as still looking.
  const [found, setFound] = useState<{
    readonly id: string;
    readonly candidates: ReadonlyArray<Candidate>;
    readonly outdated?: true;
  } | null>(null);
  const candidates = found?.id === project.id ? found.candidates : null;
  const outdated = found?.id === project.id && found.outdated === true;
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const file = useRef<HTMLInputElement>(null);
  const mode = project.logoMode ?? "auto";
  const off = busy || !client || outdated;

  useEffect(() => {
    if (!client) return;
    let live = true;
    client.call("project.logo.candidates", { project_id: project.id }).then(
      (answer) => live && setFound({ id: project.id, candidates: answer.candidates }),
      (e: unknown) => {
        if (!live) return;
        if (outdatedRuntime(e)) return setFound({ id: project.id, candidates: [], outdated: true });
        setFound({ id: project.id, candidates: [] });
        setProblem(message(e));
      },
    );
    return () => {
      live = false;
    };
  }, [client, project.id]);

  const save = async (choice: Choice | Promise<Choice>) => {
    if (!client) return;
    setBusy(true);
    setProblem(null);
    try {
      const chosen = await choice;
      const saved = await client.call("project.update", {
        request_id: requestId(),
        project_id: project.id,
        logo: chosen,
      });
      // The image just drawn is the one the runtime keeps: the row shows it in the next frame, with no read.
      if (typeof chosen === "object" && saved.logo) rememberLogo(saved.logo.id, chosen.url);
      await refresh();
      onSaved?.();
    } catch (e) {
      setProblem(message(e));
    } finally {
      setBusy(false);
    }
  };
  const pick = (candidate: Candidate) =>
    save(
      imageAt(candidate.url, () => undefined)
        .then(drawLogo)
        .then((url) => ({
          url,
          ...(candidate.path !== undefined ? { path: candidate.path } : {}),
        })),
    );
  const upload = (chosen: File) => {
    if (chosen.size > UPLOAD_MAX_BYTES) return setProblem("That image is over 10 MB.");
    void save(
      decodeFile(chosen)
        .then(drawLogo)
        .then((url) => ({ url })),
    );
  };

  return (
    <div className={cn("flex min-w-0 flex-col gap-3", className)}>
      {outdated ? (
        <p className="text-[13px] text-muted-foreground">{OUTDATED}</p>
      ) : candidates === null ? (
        <p className="text-[13px] text-muted-foreground">Looking in {project.name}…</p>
      ) : candidates.length === 0 ? (
        <p className="text-[13px] text-muted-foreground">No images found in {project.name}.</p>
      ) : (
        <div
          role="group"
          aria-label={`Images in ${project.name}`}
          className="flex flex-wrap gap-1.5"
        >
          {candidates.map((candidate) => {
            const label = candidate.path ?? "GitHub avatar";
            return (
              <button
                key={candidate.path ?? candidate.url}
                type="button"
                aria-pressed={candidate.current === true}
                aria-label={label}
                title={label}
                disabled={off}
                onClick={() => void pick(candidate)}
                className="grid size-12 place-items-center rounded-lg border border-transparent outline-none transition-colors duration-75 hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none aria-pressed:border-foreground/40 aria-pressed:bg-accent/60"
              >
                <img
                  src={candidate.url}
                  alt=""
                  draggable={false}
                  className="size-8 rounded-[4px] object-contain"
                />
              </button>
            );
          })}
        </div>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="outline" size="sm" disabled={off} onClick={() => file.current?.click()}>
          Choose image…
        </Button>
        <span className="flex-1" />
        <Button
          variant="ghost"
          size="sm"
          aria-pressed={mode === "none"}
          disabled={off}
          onClick={() => void save("none")}
          className="aria-pressed:bg-accent aria-pressed:text-foreground"
        >
          No logo
        </Button>
        <Button
          variant="ghost"
          size="sm"
          aria-pressed={mode === "auto"}
          disabled={off}
          onClick={() => void save("auto")}
          className="aria-pressed:bg-accent aria-pressed:text-foreground"
        >
          Automatic
        </Button>
        <input
          ref={file}
          type="file"
          accept={ACCEPT}
          hidden
          aria-label="Choose image"
          onChange={(e) => {
            const chosen = e.currentTarget.files?.[0];
            e.currentTarget.value = "";
            if (chosen) upload(chosen);
          }}
        />
      </div>
      {problem ? (
        <p role="alert" className="text-[13px] text-destructive">
          {problem}
        </p>
      ) : null}
    </div>
  );
}

/** The picker in a dialog, from the project's ⋯ menu: it closes once a logo is saved. */
export function ProjectLogoDialog({
  project,
  open,
  onOpenChange,
}: {
  project: Project;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="sm" aria-describedby={undefined}>
        <DialogHeader>
          <DialogTitle>Logo for {project.name}</DialogTitle>
        </DialogHeader>
        {open ? <ProjectLogoPicker project={project} onSaved={() => onOpenChange(false)} /> : null}
      </DialogContent>
    </Dialog>
  );
}
