// The Chief's existing Board view on its own, without a transcript or side panel.
import { Button } from "@caveman-app/ui/components/button";
import { cn } from "@caveman-app/ui/lib/cn";
import { useEffect } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { SurfaceEmpty } from "../panels/chrome.tsx";
import { PageBar, pageTitle } from "../shell/PageBar.tsx";
import { CrownIcon } from "@caveman-app/ui/icons/huge";
import { useChief } from "../state/chief.ts";
import { chiefPath, useChiefGone } from "../state/chiefs.ts";
import { WorkContent } from "./chief/work.tsx";

export function BoardRoute() {
  const { chiefId } = useParams();
  const chief = useChief(chiefId);
  // A Chief removed while its board is open (here, or its project in another window) leaves for home, as its chat does.
  const gone = useChiefGone(chiefId);
  const navigate = useNavigate();
  useEffect(() => {
    if (gone) navigate("/chief", { replace: true });
  }, [gone]);
  const chat = chief.profile
    ? chiefPath(chief.profile)
    : chiefId
      ? `/chief/${encodeURIComponent(chiefId)}`
      : "/chief";
  return (
    <section aria-label="Board" className="flex min-h-0 min-w-0 flex-1 flex-col bg-background">
      {/* The bar every sidebar page has (PageBar): on a phone it leads with the menu button, the only way back to the
          drawer once opening the board has closed it. */}
      <PageBar icon="chief">
        {chief.profile ? (
          <span className="min-w-0 truncate text-[13px] text-muted-foreground">
            {chief.profile.name}
          </span>
        ) : null}
        <h1 className={cn("shrink-0", pageTitle)}>Board</h1>
        <Button asChild variant="ghost" size="sm" className="ml-auto">
          <Link to={chat}>Chat</Link>
        </Button>
      </PageBar>
      {chief.status === "ready" ? (
        <WorkContent
          workspaceId={chief.workspace?.id ?? chiefId ?? ""}
          chiefId={chiefId}
          view="board"
        />
      ) : (
        <SurfaceEmpty
          icon={CrownIcon}
          title={chief.status === "loading" ? "Opening board…" : "Board unavailable"}
        >
          {chief.error ??
            (chief.status === "loading" ? null : "Open this board on your Chief's computer.")}
        </SurfaceEmpty>
      )}
    </section>
  );
}
