// A Cloud refusal at the kept-computer limit says the way past it where it shows (m-21): Settings > Computers, where
// a Cloud computer is deleted. New workspace, a new chat on
// Cloud and a pull request's Ask on a new Cloud computer use this, whether Cloud said no to this tab or to This Mac's
// runtime for it (refusalView reads Cloud's code either way).
import { cn } from "@caveman-app/ui/lib/cn";
import { Link } from "react-router";
import { atKeptLimit } from "../../state/cloud.ts";

export const COMPUTERS_ROUTE = "/settings/computers";

const LINK = "w-fit rounded-sm text-foreground underline underline-offset-2 outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background";

/** "Your Cloud computers", for a refusal deleting one gets past; nothing for any other error. `onGo`: close what it is in. */
export function KeptLimitLink({ error, onGo, className }: { error: unknown; onGo?: () => void; className?: string }) {
  if (!atKeptLimit(error)) return null;
  return (
    <Link to={COMPUTERS_ROUTE} onClick={onGo} className={cn(LINK, className)}>
      Your Cloud computers
    </Link>
  );
}
