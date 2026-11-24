// Claude Agent and Codex in Cloud: a chat whose agent has nothing to run on there shows one line with its button.
// A plan is connected once, on the person's Mac, and then works in Cloud too; nothing is signed in on a Cloud
// computer (EngineDescriptor.auth.no_sign_in_here). So the line says what is missing ("Claude isn't connected for
// Cloud.") and its button starts the same sign-in Settings > Models & keys does, on this window's own Mac. When it
// lands the runtime runs the message that was waiting by itself (runtime session-protocol/connectionNotes.ts).
//
// A Cloud from before that signs each computer in (signsInThere), and for it the card is as it was: "Sign in" starts
// the CLI's own login in the runtime's container, where the agent can neither read nor write it (runtime
// cloudLink/signInHere.ts); the card shows the page to open and, for Claude, takes the code that page shows.
import type { EngineAccount, EngineDescriptor, Workspace } from "@caveman-app/session-protocol";
import { Button } from "@caveman-app/ui/components/button";
import { Input } from "@caveman-app/ui/components/input";
import { useEffect, useState, type FormEvent } from "react";
import { NavLink } from "react-router";
import { engineReady } from "../../state/engines.ts";
import { requestId, useRuntimeClient, useRuntimeSelector, useWebWindow } from "../../state/runtime.tsx";
import { Connecting, useConnectAgent, useNow } from "../../routes/settings/Connections.tsx";
import { connectionsOf, connectionState, connectLabel, MANAGE, untilText } from "../../routes/settings/connections-model.ts";
import { EngineMark } from "../transcript/marks.tsx";
import { ReportButton } from "../../components/ReportButton.tsx";

type SignInEngine = "claude-agent" | "codex";

const COPY: Record<SignInEngine, { title: string; line: string; key: string }> = {
  "claude-agent": { title: "Sign in to Claude for Cloud", line: "Sign in with Claude, or add an Anthropic key. It then works in Cloud.", key: "Anthropic API key" },
  codex: { title: "Sign in to ChatGPT for Cloud", line: "Sign in with ChatGPT, or add an OpenAI key. It then works in Cloud.", key: "OpenAI API key" },
};

/**
 * The chat's engine as the chat's own computer reports it. A Cloud chat in a window whose runtime is another computer
 * (the desktop app's is This Mac) asks the chat's computer (engine.list, again on engine.changed and on a reconnect):
 * `here`, the window's own, tells This Mac's logins, which a Cloud computer never uses. Undefined until that
 * computer answers (asleep, or still connecting), so no card shows for what is not known.
 */
export function useEngineThere(workspace: Pick<Workspace, "engine" | "computer">, here: EngineDescriptor | undefined): EngineDescriptor | undefined {
  const { client, connection } = useRuntimeClient();
  const home = useRuntimeSelector((v) => v.client);
  const elsewhere = client !== null && client !== home && workspace.computer.kind === "caveman_cloud";
  const [there, setThere] = useState<EngineDescriptor | undefined>(undefined);
  useEffect(() => {
    if (!elsewhere || !client) return;
    let live = true;
    const take = (engines: ReadonlyArray<EngineDescriptor>) => void (live && setThere(engines.find((e) => e.id === workspace.engine)));
    client.call("engine.list", {}).then(
      (r) => take(r.engines),
      () => undefined,
    );
    const off = client.on("engine.changed", ({ engines }) => take(engines));
    return () => {
      live = false;
      off();
    };
  }, [client, connection, elsewhere, workspace.engine]);
  return elsewhere ? there : here;
}

/** What each other computer last said its engines are, so a chat opened again shows them at once. */
const enginesSaid = new WeakMap<object, ReadonlyArray<EngineDescriptor>>();

/**
 * The engines of the computer this surface's chat runs on, for its model picker. In a window whose runtime is another
 * computer (the desktop app's is This Mac) a Cloud chat asks its own computer (engine.list, again on engine.changed
 * and on a reconnect): the window's list is This Mac's, whose models, Auto and logins that computer does not have. A
 * model picked from This Mac's list (Auto, which a Cloud computer does not run for Claude Agent or Codex) was sent
 * and refused. Until that computer answers: what it last said, else none, so nothing is offered that may not run there.
 */
export function useEnginesThere(): ReadonlyArray<EngineDescriptor> {
  const { client, connection } = useRuntimeClient();
  const home = useRuntimeSelector((v) => v.client);
  const here = useRuntimeSelector((v) => v.engines);
  const elsewhere = client !== null && client !== home;
  const [there, setThere] = useState<{ readonly of: object; readonly engines: ReadonlyArray<EngineDescriptor> } | undefined>(undefined);
  useEffect(() => {
    if (!elsewhere || !client) return;
    let live = true;
    const take = (engines: ReadonlyArray<EngineDescriptor>) => {
      enginesSaid.set(client, engines);
      if (live) setThere({ of: client, engines });
    };
    client.call("engine.list", {}).then(
      (r) => take(r.engines),
      () => undefined,
    );
    const off = client.on("engine.changed", ({ engines }) => take(engines));
    return () => {
      live = false;
      off();
    };
  }, [client, connection, elsewhere]);
  if (!elsewhere || !client) return here;
  return (there?.of === client ? there.engines : undefined) ?? enginesSaid.get(client) ?? NO_ENGINES;
}
const NO_ENGINES: ReadonlyArray<EngineDescriptor> = [];

/**
 * The chat needs the card: its engine is Claude Agent or Codex, on a Cloud computer, with nothing to run on there.
 * A plan or key that is connected and can run it now means no card, whatever the agent's own CLI says of itself.
 */
export function needsEngineSignIn(workspace: Pick<Workspace, "engine" | "computer">, engine: EngineDescriptor | undefined, now = Date.now()): engine is EngineDescriptor & { id: SignInEngine } {
  return (
    workspace.computer.kind === "caveman_cloud" &&
    (workspace.engine === "claude-agent" || workspace.engine === "codex") &&
    engine !== undefined &&
    !engineReady(engine) &&
    engine.auth.state !== "checking" &&
    !connectionsOf(engine.auth.accounts).some((account) => account.connection !== undefined && ["ready", "expiring"].includes(connectionState(account.connection, now).is))
  );
}

/**
 * Whether the card may offer a sign-in or a key field on the chat's computer. Not where the person's credentials stay
 * outside it (EngineDescriptor.auth.no_sign_in_here): there the card only says what to connect, and where.
 */
export const signsInThere = (engine: Pick<EngineDescriptor, "auth">): boolean => engine.auth.no_sign_in_here !== true;

/** What a chat in Cloud is missing, and what its one line says about it. */
export interface CloudNeed {
  /** connect: nothing connected. reconnect: the plan's sign-in ended. admin_off, used_up: nothing to press here. */
  readonly kind: "connect" | "reconnect" | "admin_off" | "used_up";
  readonly line: string;
  /** The plan Reconnect replaces. */
  readonly account?: EngineAccount;
}

/**
 * Why the chat's agent has nothing to run on in Cloud, from what its computer lists (the plans and keys the person
 * connected, each with its state): a sign-in that ended, a plan used up until its reset (the chat carries on by
 * itself then), plans the admin turned off, else nothing connected at all. The agent's own CLI message is never
 * shown: on a Cloud computer it asks for a key the person does not need.
 */
export function cloudNeed(engine: Pick<EngineDescriptor, "id" | "auth">, now: number, timeZone?: string): CloudNeed {
  const plan = engine.id === "codex" ? "ChatGPT" : "Claude";
  const key = engine.id === "codex" ? "an OpenAI key" : "an Anthropic key";
  const states = connectionsOf(engine.auth.accounts).flatMap((account) => (account.connection ? [{ account, state: connectionState(account.connection, now, timeZone) }] : []));
  const ended = states.find((c) => c.state.is === "expired" && c.state.reconnect);
  if (ended) return { kind: "reconnect", line: `Your ${plan} sign-in expired.`, account: ended.account };
  const usedUp = states.find((c) => c.state.is === "used_up");
  if (usedUp) {
    const until = untilText(usedUp.account.connection?.used_up_until, now, timeZone);
    return { kind: "used_up", line: until === undefined ? `${plan} plan used up.` : `${plan} plan used up until ${until}.` };
  }
  if (states.some((c) => c.state.is === "off")) return { kind: "admin_off", line: `Your admin turned ${plan} plans off. Add ${key}, or run this chat on your Mac.` };
  return { kind: "connect", line: `${plan} isn't connected for Cloud.` };
}

export function EngineSignInCard(props: { workspaceId: string; engine: EngineDescriptor & { id: SignInEngine } }) {
  if (signsInThere(props.engine)) return <SignInThereCard {...props} />;
  return <ConnectLine engine={props.engine} />;
}

/** The chat's one quiet line: the agent's mark, what is missing, and its button. */
function ConnectLine({ engine }: { engine: EngineDescriptor & { id: SignInEngine } }) {
  const now = useNow();
  return (
    <div className="mt-6 flex flex-wrap items-center gap-x-3 gap-y-2 text-[13px] leading-5">
      <EngineMark engine={engine.id} />
      <CloudNeedLine engine={engine.id} need={cloudNeed(engine, now)} />
    </div>
  );
}

/**
 * What a chat in Cloud is missing and its one button, for the row that holds them: a chat's own line, and New
 * chat's foot before Send. The sign-in is made on this window's own computer (the desktop app's is the person's
 * Mac), never on the chat's, and the person stays where they are. A browser window starts none: its line says the
 * Mac app connects it, and for a Claude plan "No Mac?" leads to Settings > Models & keys, where a token is pasted.
 * `compact`: the smaller button of a foot line.
 */
export function CloudNeedLine({ engine, need, compact = false }: { engine: SignInEngine; need: { readonly kind: string; readonly line: string; readonly account?: EngineAccount | undefined }; compact?: boolean }) {
  const home = useRuntimeSelector((v) => v.client);
  const here = useRuntimeSelector((v) => v.engines).find((e) => e.id === engine);
  const connect = useConnectAgent(engine);
  const web = useWebWindow() !== null;
  const canConnect = !web && here?.auth.everywhere === "available";
  const asks = need.kind === "connect" || need.kind === "reconnect";
  const fromMac = web && asks ? ` ${need.kind === "reconnect" ? MANAGE.againFromMac : MANAGE.fromMac}.` : "";
  const small = compact ? "h-6 shrink-0 px-2" : undefined;
  return (
    <>
      <span className="min-w-0 flex-1 text-muted-foreground">
        {connect.pending ? <Connecting connect={connect} codex={engine === "codex"} /> : connect.failed !== undefined ? <span role="alert" className="text-destructive">{connect.failed}</span> : `${need.line}${fromMac}`}
      </span>
      {connect.pending ? (
        connect.mine ? (
          <Button type="button" size="sm" variant="ghost" className={small} onClick={connect.cancel}>
            Cancel
          </Button>
        ) : null
      ) : !asks ? null : canConnect ? (
        <Button type="button" size="sm" variant="secondary" className={small} disabled={!home} onClick={() => connect.start(need.account ? { replaces: need.account } : {})}>
          {connect.failed !== undefined ? "Try again" : need.kind === "reconnect" ? "Reconnect" : connectLabel(engine)}
        </Button>
      ) : web ? (
        engine === "claude-agent" ? (
          <Button asChild size="sm" variant="ghost" className={small}>
            <NavLink to="/settings/models">{MANAGE.noMac}</NavLink>
          </Button>
        ) : null
      ) : (
        <Button asChild size="sm" variant="secondary" className={small}>
          <NavLink to="/settings/models">Models & keys</NavLink>
        </Button>
      )}
    </>
  );
}

function SignInThereCard({ workspaceId: _workspaceId, engine }: { workspaceId: string; engine: EngineDescriptor & { id: SignInEngine } }) {
  const { client } = useRuntimeClient();
  const refresh = useRuntimeSelector((v) => v.refresh);
  const copy = COPY[engine.id];
  const [keyOpen, setKeyOpen] = useState(false);
  const [key, setKey] = useState("");
  // The sign-in's page (and Codex's one-time code) once it started.
  const [page, setPage] = useState<{ url?: string; code?: string; message?: string } | null>(null);
  const [pasted, setPasted] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await action();
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  // The CLI's own login, in the runtime's container on this computer: its page to open.
  const signIn = () =>
    run(async () => {
      setPage(await client!.call("engine.account.signin", { request_id: requestId(), engine: engine.id, provider: "follow" }));
    });
  // Claude: the code the page shows, typed into the CLI by the runtime. Codex: "Check again" once the page says done.
  const finish = (e?: FormEvent) => {
    e?.preventDefault();
    const value = pasted.trim();
    setPasted("");
    if (engine.id === "claude-agent" && value === "") return;
    void run(async () => {
      await client!.call("engine.account.complete", { request_id: requestId(), engine: engine.id, account_id: "follow", callback_url: value });
      setPage(null);
    });
  };
  const submitKey = (e: FormEvent) => {
    e.preventDefault();
    const value = key.trim();
    // The field never keeps a key, whatever the answer.
    setKey("");
    if (value) void run(async () => void (await client!.call("engine.account.add", { request_id: requestId(), engine: engine.id, key: value })));
  };
  return (
    <div className="mt-6 flex flex-col gap-3 rounded-xl border border-border bg-card px-4 py-3">
      <div className="flex items-start gap-3">
        <EngineMark engine={engine.id} className="mt-0.5" />
        <div className="min-w-0 flex-1">
          <div className="text-[13px] text-foreground">{copy.title}</div>
          <div className="text-[13px] leading-5 text-muted-foreground">{page?.message ?? copy.line}</div>
        </div>
      </div>
      {page ? (
        <div className="flex flex-col gap-2 pl-8">
          {page.url ? (
            <a href={page.url} target="_blank" rel="noopener noreferrer" className="self-start text-[13px] font-medium text-foreground underline underline-offset-2">
              Open the sign-in page
            </a>
          ) : null}
          {page.code ? (
            <div className="text-[13px] text-muted-foreground">
              Code: <span className="font-mono text-foreground">{page.code}</span>
            </div>
          ) : null}
          {engine.id === "claude-agent" ? (
            <form onSubmit={finish} className="flex items-center gap-2">
              <Input
                aria-label="Code from the sign-in page"
                placeholder="Paste the code the page shows"
                autoComplete="off"
                data-1p-ignore
                data-lpignore="true"
                spellCheck={false}
                value={pasted}
                onChange={(e) => setPasted(e.target.value)}
                className="h-7 min-w-0 flex-1 font-mono placeholder:font-sans"
              />
              <Button type="submit" size="sm" disabled={busy || pasted.trim() === ""}>
                {busy ? "Signing in…" : "Finish"}
              </Button>
            </form>
          ) : (
            <Button type="button" size="sm" className="self-start" disabled={busy} onClick={() => finish()}>
              {busy ? "Checking…" : "Check again"}
            </Button>
          )}
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-2 pl-8">
          <Button type="button" size="sm" disabled={busy || !client} onClick={() => void signIn()}>
            {busy ? "Starting…" : "Sign in"}
          </Button>
          {!keyOpen ? (
            <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={() => setKeyOpen(true)}>
              Use an API key
            </Button>
          ) : null}
        </div>
      )}
      {keyOpen && !page ? (
        <form onSubmit={submitKey} className="flex flex-col gap-1.5 pl-8">
          <div className="flex items-center gap-2">
            <Input
              type="password"
              // A key is not a site password: keep browsers and password managers from offering to save it.
              autoComplete="new-password"
              data-1p-ignore
              data-lpignore="true"
              spellCheck={false}
              aria-label={copy.key}
              placeholder={`Paste an ${copy.key}`}
              value={key}
              onChange={(e) => setKey(e.target.value)}
              className="h-7 min-w-0 flex-1 font-mono placeholder:font-sans"
            />
            <Button type="submit" size="sm" variant="outline" disabled={busy || key.trim() === ""}>
              {busy ? "Checking…" : "Use key"}
            </Button>
          </div>
        </form>
      ) : null}
      {error ? (
        <p role="alert" className="flex items-center gap-1 pl-8 text-[12.5px] text-destructive">
          <span className="min-w-0 flex-1">{error}</span>
          <ReportButton request={{ surface: "install", error: { name: "EngineSignInFailed", message: error } }} />
        </p>
      ) : null}
    </div>
  );
}
