// Inline artifact cards: the whole card is one button that opens the artifact
// in the side panel. Files show a mini diff. A pull request opens its review
// beside the chat (⌘-click: on its host). Images and screenshots are
// thumbnails of their own (gallery/Gallery.tsx).
import { ArtifactCard, ArtifactDiffPreview } from "@caveman-app/ui/ai/artifact";
import { useContext, type MouseEvent } from "react";
import { useNavigate } from "react-router";
import { editorClick, FileRefsContext } from "../../panels/files/FileChip.tsx";
import { useFileMenu } from "../../panels/files/FileMenu.tsx";
import { prFromUrl } from "../../routes/review/model.ts";
import { openPr } from "../../routes/review/surface.tsx";
import { useOpenSurface } from "../../panels/navigation.tsx";
import { useChatWorkspace } from "./root.ts";
import { useRuntime } from "../../state/runtime.tsx";
import { diffPreview } from "../../state/transcript-artifacts.ts";
import type { Artifact } from "../../state/transcript-model.ts";
import { artifactIcon, Icon } from "./marks.tsx";

export interface CardActions {
  readonly onOpen?: ((artifactId: string) => void) | undefined;
  readonly openId?: string | null | undefined;
}

export function ArtifactCards({ artifacts, onOpen, openId }: { artifacts: ReadonlyArray<Artifact> } & CardActions) {
  if (!artifacts.length) return null;
  return (
    <div className="flex flex-col gap-1.5 py-1">
      {artifacts.map((a) => (
        <Card key={a.id} artifact={a} onOpen={onOpen} openId={openId} />
      ))}
    </div>
  );
}

export function Card({ artifact: a, onOpen, openId }: { artifact: Artifact } & CardActions) {
  const open = () => onOpen?.(a.id);
  // A file's card, right-clicked: the file's menu (Open in the editor, Reveal in Finder, its path).
  const { onContextMenu, menu } = useFileMenu(useContext(FileRefsContext));
  const badge = <Icon icon={artifactIcon(a.kind, a.kind === "file" ? a : undefined)} />;
  const common = { badge, onClick: open, current: openId === a.id, disabled: !onOpen, "aria-label": `Open ${a.title}, ${a.meta}` };
  switch (a.kind) {
    case "file": {
      const lines = a.diff ? diffPreview(a.diff, 4) : [];
      const total = (a.added ?? 0) + (a.removed ?? 0);
      return (
        <>
          <ArtifactCard
            {...common}
            onContextMenu={onContextMenu({ path: a.path, exact: true })}
            title={<span className="font-mono text-[12.5px]">{a.title}</span>}
            meta={
              // No counts from the engine (the Caveman engine's edits carry none): say what happened, not "+0 −0".
              a.change === "created" || (a.added == null && a.removed == null) ? (
                a.meta
              ) : (
                <span className="flex gap-1.5">
                  <span className="text-diff-add-ink">+{a.added ?? 0}</span>
                  <span className="text-diff-del-ink">−{a.removed ?? 0}</span>
                </span>
              )
            }
            preview={lines.length ? <ArtifactDiffPreview lines={lines} more={Math.max(0, total - lines.length)} /> : undefined}
          />
          {menu}
        </>
      );
    }
    case "pr":
      return <PrCard artifact={a} open={open} badge={badge} current={openId === a.id} />;
    default:
      return <ArtifactCard {...common} title={a.title} meta={a.meta} />;
  }
}

function PrCard({ artifact: a, open, badge, current }: { artifact: Extract<Artifact, { kind: "pr" }>; open: () => void; badge: React.ReactNode; current: boolean }) {
  const openSurface = useOpenSurface();
  const { projects } = useRuntime();
  const navigate = useNavigate();
  const chat = useChatWorkspace();
  const pr = prFromUrl(a.url, projects);
  const onClick = (e: MouseEvent) => {
    if (editorClick(e)) window.open(a.url, "_blank", "noreferrer");
    else if (pr) openPr(navigate, chat, pr, openSurface);
    else open();
  };
  return <ArtifactCard badge={badge} onClick={onClick} current={current} title={a.title} meta={pr ? `${a.meta} · Review` : a.meta} aria-label={pr ? `Review ${a.title} in ${a.meta}` : `Open ${a.title}, ${a.meta}`} />;
}
