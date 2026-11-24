// "Report a problem" (docs/): the preview every report
// button opens. It gathers this computer's recent logs through the runtime (or
// the desktop app when the runtime cannot run), all redacted before they reach
// this page, lets the person's own model describe the problem, and shows
// exactly what Send would send: the report itself, each log file, the chat
// excerpt and the screenshot, each one a switch. Nothing leaves before Send.
import { Button } from "@caveman-app/ui/components/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@caveman-app/ui/components/dialog";
import { Input } from "@caveman-app/ui/components/input";
import { Switch } from "@caveman-app/ui/components/switch";
import { cn } from "@caveman-app/ui/lib/cn";
import type { BugReportPrepared, BugReportRecord } from "@caveman-app/session-protocol";
import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import {
  base64,
  desktopBackend,
  excerptSent,
  filesSent,
  initialInclude,
  removedLine,
  REPORT_EVENT,
  reportPart,
  runtimeBackend,
  statusLine,
  typed,
  type Include,
  type ReportBackend,
  type ReportRequest,
} from "../state/bug-report.ts";
import { useRuntimeClient } from "../state/runtime.tsx";
import { BUG_REPORTS_UNAVAILABLE } from "@caveman-app/bug-report";

const TEXTAREA =
  "w-full resize-y rounded-md border border-input bg-control px-2.5 py-1.5 text-[13px] leading-5 placeholder:text-[hsl(var(--subtle-foreground))] focus-visible:border-ring focus-visible:outline-none";

/** Mounted once above every screen, onboarding included: opens on reportProblem() and the desktop's Help menu. */
export function ReportProblemHost() {
  const { status, client } = useRuntimeClient();
  const [open, setOpen] = useState<{
    request: ReportRequest;
    screenshot: string | undefined;
    key: number;
  } | null>(null);
  useEffect(() => {
    let live = true;
    const start = async (request: ReportRequest) => {
      window.cavemanPendingReport = null;
      // The window as it looks now, before the preview covers it. Sent only if the person turns it on.
      const png = await window.cavemanDesktop?.bugReport?.screenshot().catch(() => null);
      if (live) setOpen({ request, screenshot: png ? base64(png) : undefined, key: Date.now() });
    };
    const onEvent = (event: Event) =>
      void start((event as CustomEvent<ReportRequest>).detail ?? { surface: "other" });
    window.addEventListener(REPORT_EVENT, onEvent);
    // The desktop asked before this page listened (Help menu during start-up, the startup recovery window).
    if (window.cavemanPendingReport) void start(window.cavemanPendingReport);
    return () => {
      live = false;
      window.removeEventListener(REPORT_EVENT, onEvent);
    };
  }, []);
  const bridge = window.cavemanDesktop?.bugReport;
  // A runtime still connecting (a reload, the app starting) gets a few seconds before the desktop's own path.
  const [patience, setPatience] = useState(false);
  useEffect(() => {
    setPatience(false);
    if (!open) return;
    const timer = setTimeout(() => setPatience(true), WAIT_FOR_RUNTIME_MS);
    return () => clearTimeout(timer);
  }, [open]);
  // The runtime gathers and sends; while it cannot run, the desktop app gathers its own logs and queues for it.
  // The dialog keeps whichever prepared its report: a reconnect mid-preview must not lose it.
  const connected = status === "connected" && client !== null;
  const backend = useMemo<ReportBackend | null>(
    () =>
      connected && client
        ? runtimeBackend(client)
        : bridge && (patience || status === "error")
          ? desktopBackend(bridge)
          : null,
    [connected, client, bridge, patience, status],
  );
  if (!open) return null;
  const close = () => {
    setOpen(null);
    if (backend?.kind === "desktop") bridge?.done();
  };
  return (
    <ReportDialog
      key={open.key}
      request={open.request}
      screenshot={open.screenshot}
      backend={backend}
      waiting={!backend && status === "connecting"}
      onClose={close}
    />
  );
}

const WAIT_FOR_RUNTIME_MS = 5_000;

type Phase =
  | { readonly kind: "gathering" }
  | { readonly kind: "preview"; readonly prepared: BugReportPrepared }
  | { readonly kind: "sending"; readonly prepared: BugReportPrepared }
  | { readonly kind: "sent"; readonly record: BugReportRecord }
  | { readonly kind: "failed"; readonly message: string; readonly prepared?: BugReportPrepared };

export function ReportDialog({
  request,
  screenshot,
  backend: offered,
  waiting = false,
  onClose,
  onDelete,
}: {
  request: ReportRequest;
  screenshot: string | undefined;
  backend: ReportBackend | null;
  /** The runtime is still connecting: wait for it rather than fail. */
  waiting?: boolean;
  onClose: () => void;
  /** Deletes a sent report (bug_report.delete); absent where the runtime cannot be reached. */
  onDelete?: ((reportId: string) => Promise<void>) | undefined;
}) {
  const { client, status } = useRuntimeClient();
  const [phase, setPhase] = useState<Phase>({ kind: "gathering" });
  const [title, setTitle] = useState("");
  const [summary, setSummary] = useState("");
  const [note, setNote] = useState("");
  const [include, setInclude] = useState<Include>({
    logs: true,
    screenshot: false,
    thread_excerpt: false,
    code: false,
  });
  // What the person typed in: a model's description arriving later never overwrites it.
  const dirty = useRef({ title: false, summary: false });
  const [describing, setDescribing] = useState<"idle" | "running" | "agent" | { failed: string }>(
    "idle",
  );
  const [attempt, setAttempt] = useState(0);
  // The backend that prepared this report sends it, whatever the connection does meanwhile.
  const [kept, setKept] = useState<ReportBackend | null>(null);
  const backend = kept ?? offered;

  useEffect(() => {
    if (kept) return;
    if (!backend) {
      setPhase(
        waiting
          ? { kind: "gathering" }
          : {
              kind: "failed",
              message:
                "Caveman Code's runtime isn't reachable, so its logs can't be gathered. Try again once it's back.",
            },
      );
      return;
    }
    let live = true;
    setPhase({ kind: "gathering" });
    backend.prepare(request, screenshot).then(
      (prepared) => {
        if (!live) return;
        setKept(backend);
        setTitle(prepared.title);
        setSummary(prepared.summary);
        setInclude(initialInclude(prepared));
        setPhase({ kind: "preview", prepared });
        if (!backend.describe) return;
        setDescribing("running");
        backend.describe(prepared.report_id).then(
          (written) => {
            if (!live) return;
            if (written.drafted_by !== "agent")
              return setDescribing({ failed: written.error ?? "No model could write it." });
            if (!dirty.current.title) setTitle(written.title);
            if (!dirty.current.summary) setSummary(written.summary);
            setDescribing("agent");
          },
          (error: unknown) =>
            live &&
            setDescribing({ failed: error instanceof Error ? error.message : String(error) }),
        );
      },
      (error: unknown) =>
        live &&
        setPhase({
          kind: "failed",
          message: `Couldn't gather the report: ${error instanceof Error ? error.message : String(error)}`,
        }),
    );
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once kept, the report is never prepared again
  }, [backend, waiting, request, screenshot, attempt]);

  const send = (prepared: BugReportPrepared) => {
    if (!backend) return;
    setPhase({ kind: "sending", prepared });
    backend.send(prepared.report_id, { title, summary, note }, include).then(
      (record) => setPhase({ kind: "sent", record }),
      (error: unknown) =>
        setPhase({
          kind: "failed",
          message: `Not sent: ${error instanceof Error ? error.message : String(error)}`,
          prepared,
        }),
    );
  };
  const remove =
    onDelete ??
    (client && status === "connected"
      ? (id: string) =>
          client
            .call("bug_report.delete", { request_id: crypto.randomUUID(), report_id: id })
            .then(() => undefined)
      : undefined);

  const prepared =
    phase.kind === "preview" || phase.kind === "sending"
      ? phase.prepared
      : phase.kind === "failed"
        ? phase.prepared
        : undefined;
  return (
    <Dialog open onOpenChange={(next) => !next && phase.kind !== "sending" && onClose()}>
      <DialogContent size="xl" className="max-h-[88vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Report a problem</DialogTitle>
          <DialogDescription>
            Nothing is sent until you press Send. Keys, tokens, emails and your name in paths were
            removed on this computer before anything showed here.
          </DialogDescription>
        </DialogHeader>
        {phase.kind === "gathering" ? (
          <p role="status" className="py-6 text-[13px] text-muted-foreground">
            {backend
              ? "Gathering the last few hours of logs and checking them for secrets…"
              : "Waiting for Caveman Code's runtime to gather the logs…"}
          </p>
        ) : phase.kind === "sent" ? (
          <SentView
            record={phase.record}
            queuedForRuntime={backend?.kind === "desktop"}
            onDelete={remove}
            onClose={onClose}
          />
        ) : prepared ? (
          <Preview
            prepared={prepared}
            title={title}
            summary={summary}
            note={note}
            include={include}
            describing={describing}
            onTitle={(v) => {
              dirty.current.title = true;
              setTitle(v);
            }}
            onSummary={(v) => {
              dirty.current.summary = true;
              setSummary(v);
            }}
            onNote={setNote}
            onInclude={setInclude}
          />
        ) : null}
        {phase.kind === "failed" ? (
          <p role="alert" className="text-[13px] text-destructive">
            {phase.message}
          </p>
        ) : null}
        {phase.kind === "sent" ? null : (
          <DialogFooter>
            <Button variant="ghost" onClick={onClose} disabled={phase.kind === "sending"}>
              Cancel
            </Button>
            {phase.kind === "failed" && !phase.prepared ? (
              <Button onClick={() => setAttempt((n) => n + 1)}>Try again</Button>
            ) : (
              <Button
                onClick={() => prepared && send(prepared)}
                disabled={!prepared || phase.kind === "sending" || !title.trim()}
              >
                {phase.kind === "sending"
                  ? "Sending…"
                  : backend?.kind === "desktop"
                    ? "Send when the runtime is back"
                    : "Send report"}
              </Button>
            )}
          </DialogFooter>
        )}
      </DialogContent>
    </Dialog>
  );
}

function Field({
  label,
  hint,
  children,
  id,
}: {
  label: string;
  hint?: ReactNode;
  children: ReactNode;
  id: string;
}) {
  return (
    <div className="grid gap-1.5">
      <label htmlFor={id} className="text-[12px] text-muted-foreground">
        {label}
      </label>
      {children}
      {hint ? <p className="text-[12px] text-muted-foreground">{hint}</p> : null}
    </div>
  );
}

const kb = (bytes: number) =>
  bytes < 1024
    ? `${bytes} B`
    : bytes < 1024 * 1024
      ? `${Math.round(bytes / 1024)} KB`
      : `${(bytes / 1024 / 1024).toFixed(1)} MB`;

function Preview({
  prepared,
  title,
  summary,
  note,
  include,
  describing,
  onTitle,
  onSummary,
  onNote,
  onInclude,
}: {
  prepared: BugReportPrepared;
  title: string;
  summary: string;
  note: string;
  include: Include;
  describing: "idle" | "running" | "agent" | { failed: string };
  onTitle: (v: string) => void;
  onSummary: (v: string) => void;
  onNote: (v: string) => void;
  onInclude: (next: Include) => void;
}) {
  const ids = { title: useId(), summary: useId(), note: useId() };
  const files = filesSent(prepared, include);
  const codeFiles = prepared.files.filter((f) => f.code);
  const excerpt = excerptSent(prepared, include);
  const typedRemoved = typed(`${title}\n${summary}\n${note}`, include).removed;
  const removed = removedLine(prepared.redaction.counts);
  const [inspect, setInspect] = useState<string | null>(null);
  const part = reportPart(prepared, { title, summary, note }, include);
  const tabs: Array<{ id: string; label: string; body: () => ReactNode }> = [
    {
      id: "report",
      label: "The report",
      body: () => <Text text={JSON.stringify(part, null, 2)} />,
    },
    ...files.map((f) => ({
      id: `file:${f.name}`,
      label: f.name,
      body: () => <Text text={f.text} />,
    })),
    ...(excerpt !== undefined
      ? [{ id: "excerpt", label: "Chat excerpt", body: () => <Text text={excerpt} /> }]
      : []),
    ...(include.screenshot && prepared.screenshot
      ? [
          {
            id: "screenshot",
            label: "Screenshot",
            body: () => (
              <img
                alt="The screenshot that will be sent"
                className="max-h-80 rounded-md border border-border"
                src={`data:image/png;base64,${prepared.screenshot!.png_base64}`}
              />
            ),
          },
        ]
      : []),
  ];
  const shown = tabs.find((t) => t.id === inspect);
  return (
    <div className="grid gap-4">
      <Field id={ids.title} label="Title">
        <Input
          id={ids.title}
          value={title}
          maxLength={120}
          onChange={(e) => onTitle(e.target.value)}
        />
      </Field>
      <Field
        id={ids.summary}
        label="What happened"
        hint={
          describing === "running"
            ? "Your model is reading the logs to describe it…"
            : describing === "agent"
              ? "Written by your model from the logs. Change anything."
              : typeof describing === "object"
                ? `No model could describe it (${describing.failed}). Say in your own words what you did and what went wrong.`
                : null
        }
      >
        <textarea
          id={ids.summary}
          className={cn(TEXTAREA, "min-h-[150px] font-mono text-[12.5px]")}
          value={summary}
          onChange={(e) => onSummary(e.target.value)}
        />
      </Field>
      <Field id={ids.note} label="Anything to add? (optional)">
        <textarea
          id={ids.note}
          className={cn(TEXTAREA, "min-h-[60px]")}
          value={note}
          placeholder="What you were doing, how often it happens…"
          onChange={(e) => onNote(e.target.value)}
        />
      </Field>
      {typedRemoved > 0 ? (
        <p role="status" className="-mt-2 text-[12px] text-warning">
          {typedRemoved === 1
            ? "Something you typed looks like a secret"
            : `${typedRemoved} things you typed look like secrets`}
          : it's replaced with [REDACTED] in what's sent.
        </p>
      ) : null}

      <section className="grid gap-1 rounded-lg border border-border p-1">
        <h3 className="px-2 pb-1 pt-2 text-[12px] text-muted-foreground">What's sent</h3>
        <Toggle
          label="Logs"
          detail={
            prepared.files.some((f) => !f.code)
              ? `${prepared.files.filter((f) => !f.code).length} files from the last 6 hours, ${kb(prepared.files.filter((f) => !f.code || include.code).reduce((n, f) => n + f.bytes, 0))}`
              : "No recent logs on this computer"
          }
          checked={include.logs}
          disabled={prepared.files.length === 0}
          onChange={(logs) => onInclude({ ...include, logs })}
        />
        {prepared.excerpt ? (
          <Toggle
            label="The end of this chat"
            detail="Your last messages and the agent's answers"
            checked={include.thread_excerpt}
            onChange={(v) => onInclude({ ...include, thread_excerpt: v })}
          />
        ) : null}
        {prepared.screenshot ? (
          <Toggle
            label="Screenshot of the window"
            detail={`As it looked when you pressed Report, ${kb(prepared.screenshot.bytes)}`}
            checked={include.screenshot}
            onChange={(v) => onInclude({ ...include, screenshot: v })}
          />
        ) : null}
        {codeFiles.length > 0 || prepared.excerpt ? (
          <Toggle
            label="Code and file contents"
            detail={
              include.code
                ? "Code in the chat excerpt and the engines' own logs go too"
                : "Off: code, diffs and the engines' logs stay on this computer"
            }
            checked={include.code}
            onChange={(code) => onInclude({ ...include, code })}
          />
        ) : null}
      </section>

      <div className="grid gap-2">
        <div className="flex flex-wrap items-center gap-1">
          <span className="mr-1 text-[12px] text-muted-foreground">Inspect:</span>
          {tabs.map((t) => (
            <Button
              key={t.id}
              size="sm"
              variant={inspect === t.id ? "secondary" : "ghost"}
              aria-pressed={inspect === t.id}
              onClick={() => setInspect(inspect === t.id ? null : t.id)}
            >
              {t.label}
            </Button>
          ))}
        </div>
        {shown ? shown.body() : null}
        <p className="text-[12px] text-muted-foreground">
          {removed ? `${removed} ` : ""}Caveman Code {prepared.meta.app_version} (
          {prepared.meta.build_channel}) on {prepared.meta.platform} {prepared.meta.arch}. Sent over
          HTTPS; only the Caveman team can read it, and you can delete it any time.
        </p>
      </div>
    </div>
  );
}

/** A text exactly as sent; a long one shows its end first, all of it on request. */
function Text({ text }: { text: string }) {
  const LIMIT = 200_000;
  const [all, setAll] = useState(false);
  const cut = !all && text.length > LIMIT;
  return (
    <div className="grid gap-1">
      {cut ? (
        <p className="text-[12px] text-muted-foreground">
          Showing the last {kb(LIMIT)} of {kb(text.length)}; all of it is sent.{" "}
          <Button
            size="sm"
            variant="link"
            className="h-auto p-0 text-[12px]"
            onClick={() => setAll(true)}
          >
            Show all
          </Button>
        </p>
      ) : null}
      <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-all rounded-md border border-border bg-background p-3 font-mono text-[11.5px] leading-[17px] text-foreground/90">
        {cut ? text.slice(-LIMIT) : text || "(empty)"}
      </pre>
    </div>
  );
}

function Toggle({
  label,
  detail,
  checked,
  disabled,
  onChange,
}: {
  label: string;
  detail: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (v: boolean) => void;
}) {
  const id = useId();
  return (
    <div className="flex min-h-10 items-center gap-3 rounded-md px-2 py-1.5">
      <label htmlFor={id} className="grid min-w-0 flex-1 cursor-pointer">
        <span className="text-[13px] text-foreground">{label}</span>
        <span className="truncate text-[12px] text-muted-foreground">{detail}</span>
      </label>
      <Switch id={id} checked={checked} disabled={disabled} onCheckedChange={onChange} />
    </div>
  );
}

function SentView({
  record,
  queuedForRuntime,
  onDelete,
  onClose,
}: {
  record: BugReportRecord;
  queuedForRuntime: boolean;
  onDelete: ((reportId: string) => Promise<void>) | undefined;
  onClose: () => void;
}) {
  const [deleting, setDeleting] = useState<"idle" | "busy" | "done" | { failed: string }>("idle");
  const sent = record.state === "sent";
  return (
    <div className="grid gap-3 py-2">
      <p role="status" className="text-[13px] text-foreground">
        {sent
          ? record.duplicate_of
            ? "Sent. Others reported this too, so it's already on the team's list. Thank you."
            : "Sent. The team reads every report. Thank you."
          : queuedForRuntime
            ? "Saved. It sends when Caveman Code's runtime runs again."
            : record.last_error === BUG_REPORTS_UNAVAILABLE
              ? `${BUG_REPORTS_UNAVAILABLE} Your report is saved on this computer and sends once they are.`
              : record.state === "failed"
                ? `Not sent: ${record.last_error ?? "Caveman refused it."}`
                : record.last_error?.startsWith("Sign in")
                  ? "Saved on this computer. It sends by itself once you sign in to Caveman."
                  : "Saved on this computer. It sends by itself once Caveman can be reached."}
      </p>
      <p className="text-[12px] text-muted-foreground">
        Status: {statusLine(record).replace(/\.$/, "")}. Settings &gt; Problem reports shows what
        becomes of it.
      </p>
      {deleting === "done" ? (
        <p role="status" className="text-[12px] text-muted-foreground">
          Deleted, with its logs.
        </p>
      ) : typeof deleting === "object" ? (
        <p role="alert" className="text-[12px] text-destructive">
          {deleting.failed}
        </p>
      ) : null}
      <DialogFooter>
        {onDelete && deleting !== "done" ? (
          <Button
            variant="ghost"
            disabled={deleting === "busy"}
            onClick={() => {
              setDeleting("busy");
              onDelete(record.report_id).then(
                () => setDeleting("done"),
                (error: unknown) =>
                  setDeleting({
                    failed: `Couldn't delete it: ${error instanceof Error ? error.message : String(error)}`,
                  }),
              );
            }}
          >
            Delete this report
          </Button>
        ) : null}
        <Button onClick={onClose}>Done</Button>
      </DialogFooter>
    </div>
  );
}
