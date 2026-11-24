// The one button beside an error (docs/): it opens the
// "Report a problem" preview with this error filled in. Nothing is gathered
// until it opens and nothing is sent until the person presses Send there.
import { Button } from "@caveman-app/ui/components/button";
import { cn } from "@caveman-app/ui/lib/cn";
import { reportProblem, type ReportRequest } from "../state/bug-report.ts";

export function ReportButton({
  request,
  className,
  label = "Report",
}: {
  request: ReportRequest;
  className?: string;
  label?: string;
}) {
  return (
    <Button
      type="button"
      size="sm"
      variant="ghost"
      className={cn("shrink-0 text-foreground", className)}
      aria-label={`${label} this problem to Caveman`}
      onClick={() => reportProblem(request)}
    >
      {label}
    </Button>
  );
}
