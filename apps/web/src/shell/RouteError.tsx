// What broke, Reload, and the report button with the error and its stack, instead of a blank window: for a screen that
// threw while drawing (React Router's errorElement, RouteError), and for the whole window when what threw sits above
// the router (AppErrorBoundary: the runtime provider and what it works out from Cloud's list). A blank window on a Mac
// is a see-through one (styles.css), so this paints its own background. The report sends nothing until the person
// reads it and presses Send.
import { Button } from "@caveman-app/ui/components/button";
import { Component, type ErrorInfo, type ReactNode } from "react";
import { useRouteError } from "react-router";
import { reportedError } from "../state/bug-report.ts";
import { countPageCrash } from "../state/desktop.ts";
import { NoRuntimeScope } from "../state/runtime.tsx";
import { ReportButton } from "../components/ReportButton.tsx";
import { ReportProblemHost } from "./ReportProblem.tsx";

export function RouteError() {
  return <CrashScreen title="Something broke on this screen" error={useRouteError()} />;
}

function CrashScreen({ title, error: thrown }: { title: string; error: unknown }) {
  const error = reportedError(thrown);
  return (
    <div role="alert" className="grid h-full place-items-center bg-background px-6 text-foreground">
      <div className="flex w-full max-w-[480px] flex-col gap-3">
        <h1 className="text-[15px] font-medium">{title}</h1>
        <p className="text-[13px] text-muted-foreground">
          Your chats are safe: they live in the runtime. Reload to carry on, and tell the team so it
          gets fixed.
        </p>
        <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-md border border-border bg-card p-3 font-mono text-[12px] text-destructive">
          {error.name ? `${error.name}: ` : ""}
          {error.message}
        </pre>
        <div className="flex gap-2">
          <Button onClick={() => window.location.reload()}>Reload</Button>
          <ReportButton
            request={{ surface: "other", error }}
            label="Report a problem"
            className="h-8 px-3 text-[13px]"
          />
        </div>
      </div>
    </div>
  );
}

/**
 * Around the whole page (main.tsx). Once the runtime provider threw it is gone, so a report goes the way it goes while
 * the runtime cannot answer: on the desktop, the app gathers its own logs and queues the report (ReportProblemHost).
 */
export class AppErrorBoundary extends Component<
  { children: ReactNode },
  { thrown: { error: unknown } | null }
> {
  override state: { thrown: { error: unknown } | null } = { thrown: null };
  static getDerivedStateFromError(error: unknown) {
    return { thrown: { error } };
  }
  override componentDidCatch(error: unknown, info: ErrorInfo) {
    console.error("the window stopped drawing", error, info.componentStack);
    // Caught here, it never reaches the page's error event that reportPageErrors counts.
    countPageCrash(error);
  }
  override render() {
    if (!this.state.thrown) return this.props.children;
    return (
      <NoRuntimeScope>
        <CrashScreen title="Something broke in this window" error={this.state.thrown.error} />
        <ReportProblemHost />
      </NoRuntimeScope>
    );
  }
}
