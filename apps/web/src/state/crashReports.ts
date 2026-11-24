// The page's crash reports (docs/): an uncaught error or rejection, and an error a React
// boundary caught, with its stack and component stack. Desktop only, and only once the desktop sends crash reports
// (apps/desktop/src/crashReports.ts): Sentry's renderer SDK loads then, in a chunk of its own, and reports over IPC to
// the main process, which scrubs and gates every report again before anything leaves. In a browser nothing loads.
import { scrubCrashEvent } from "@caveman-app/bug-report/crash";

type Renderer = typeof import("@sentry/electron/renderer");

let sentry: Renderer | undefined;
/** Failures from before the reporter loaded (a few: the first ones say why), reported once it has. */
let early:
  | Array<{ readonly error: unknown; readonly componentStack?: string | undefined }>
  | undefined = [];
const EARLY_MAX = 10;

const keep = (error: unknown, componentStack?: string) => {
  if (early && early.length < EARLY_MAX) early.push({ error, componentStack });
};

const report = (Sentry: Renderer, error: unknown, componentStack: string | undefined) =>
  Sentry.captureException(error, {
    mechanism: {
      type: componentStack === undefined ? "onerror" : "react_boundary",
      handled: componentStack !== undefined,
    },
    ...(componentStack === undefined
      ? {}
      : { captureContext: { contexts: { react: { componentStack } } } }),
  });

/** Starts the page's reporter where the desktop sends crash reports; does nothing anywhere else. */
export function startCrashReports(): void {
  const bridge = window.cavemanDesktop?.crashReports;
  if (!bridge) {
    early = undefined;
    return;
  }
  const onError = (event: ErrorEvent) => keep(event.error);
  const onRejection = (event: PromiseRejectionEvent) => keep(event.reason);
  window.addEventListener("error", onError);
  window.addEventListener("unhandledrejection", onRejection);
  void bridge
    .enabled()
    .then(async (on) => {
      if (!on) return;
      const Sentry = await import("@sentry/electron/renderer");
      Sentry.init({
        // The SDK's own, less what records the person: console output, clicks, keys and requests as breadcrumbs,
        // the page's URL and headers, and a session of its own (the main process keeps the app's).
        integrations: (defaults) => [
          ...defaults.filter(
            (integration) =>
              !/^(Breadcrumbs|BrowserSession|HttpContext|.*Console.*)$/.test(integration.name),
          ),
          Sentry.breadcrumbsIntegration({
            dom: false,
            fetch: false,
            xhr: false,
            history: true,
            sentry: true,
          }),
        ],
        beforeSend: (event) => scrubCrashEvent(event),
      });
      sentry = Sentry;
      for (const { error, componentStack } of early ?? []) report(Sentry, error, componentStack);
    })
    .catch(() => undefined)
    .finally(() => {
      early = undefined;
      window.removeEventListener("error", onError);
      window.removeEventListener("unhandledrejection", onRejection);
    });
}

/** An error a React boundary caught (createRoot's onCaughtError): the screen showed its fallback instead. */
export function reportCaughtError(error: unknown, componentStack: string | undefined): void {
  if (sentry) report(sentry, error, componentStack ?? "");
  else keep(error, componentStack ?? "");
}
