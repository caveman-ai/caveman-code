// The ways in: one row per way to get an engine running, each set up in place, with no trip to Settings. Your setup
// lists them when nothing is found; New chat's "Set up an agent" can list the same ones (docs/).
// Claude Agent and Codex open their own panel (with an install command where the command is missing), the Caveman
// engine signs in to compact, GitHub Copilot, SuperGrok and external tools in one click, every harness engine.scan found
// (Cursor and the rest) opens its connect form, "An API key" opens the Caveman engine's source picker, and a plan is
// last, where this person may buy one.

import type { EngineDescriptor, EngineProvider } from "@caveman-app/session-protocol";
import { Button } from "@caveman-app/ui/components/button";
import { EngineLogo } from "@caveman-app/ui/components/runner-badge";
import { useState, type ReactNode } from "react";
import { UnlockButton } from "../../components/UnlockPlans.tsx";
import type { PlanColumn } from "../../components/unlock-model.ts";
import { useRuntimeClient } from "../../state/runtime.tsx";
import type { EngineScan } from "../../state/engine-scan.ts";
import { EngineAccounts, InstallHelp } from "../EngineAccounts.tsx";
import { FlameMark, Row } from "../onboarding/parts.tsx";
import {
  SourceMark,
  SourcePanel,
  startSignIn,
  useCavemanProviders,
  type SignInNote,
} from "../settings/CavemanProviders.tsx";
import { waysIn, type Way } from "./ways-in.ts";

/** What opens under a row: a hairline, then the panel, in line with the row's words. */
const PANEL = "mx-2.5 mb-2 border-t border-border/70 pl-[26px] pt-2.5 text-[13px]";

/**
 * `scan`: engine.scan's answer (state/engine-scan.ts useEngineScan); rows for what it found appear as it arrives.
 * `unlock`, `onUnlock`: the plan this person may buy, as the last row.
 */
export function WaysIn({
  engines,
  scan,
  unlock,
  onUnlock,
}: {
  engines: ReadonlyArray<EngineDescriptor>;
  scan: EngineScan;
  unlock?: PlanColumn | undefined;
  onUnlock?: (() => void) | undefined;
}) {
  const providers = useCavemanProviders(engines.some((e) => e.id === "caveman"));
  const [open, setOpen] = useState<string | null>(null);
  const ways = waysIn(engines, scan.found, providers);
  return (
    <>
      {ways.map((w) =>
        w.kind === "sign_in" ? (
          <SignInWay key={w.key} way={w} scan={scan} />
        ) : (
          <div key={w.key}>
            <Row
              icon={<EngineLogo engine={w.engine} />}
              label={w.label}
              desc={w.desc}
              right={
                <Button
                  size="sm"
                  variant="secondary"
                  aria-expanded={open === w.key}
                  onClick={() => setOpen(open === w.key ? null : w.key)}
                >
                  {open === w.key ? "Close" : w.action}
                </Button>
              }
            />
            {open === w.key ? (
              <div className={PANEL}>
                <EnginePanel
                  engine={engines.find((e) => e.id === w.engine)!}
                  scan={scan}
                  providers={providers}
                />
              </div>
            ) : null}
          </div>
        ),
      )}
      {unlock && onUnlock ? (
        <Row
          icon={<FlameMark />}
          label={`Caveman ${unlock.family}`}
          desc={`From $${unlock.usdMonth} a month, with up to $${unlock.upTo} of usage`}
          right={<UnlockButton onClick={onUnlock} />}
        />
      ) : null}
    </>
  );
}

/**
 * One engine set up in place: the Caveman engine's source picker (its keys, gateways, coding plans and servers),
 * else the engine's own panel; a harness's connect form is open already.
 */
export function EnginePanel({
  engine,
  scan,
  providers,
}: {
  engine: EngineDescriptor;
  scan: EngineScan;
  providers?: ReadonlyArray<EngineProvider> | null | undefined;
}) {
  if (engine.id === "caveman")
    return <SourcePanel engine={engine} {...(providers !== undefined ? { providers } : {})} />;
  const harness = engine.id !== "claude-agent" && engine.id !== "codex";
  return (
    <EngineAccounts
      engine={engine}
      form={harness}
      found={scan.found?.get(engine.id)}
      rescan={scan.rescan}
    />
  );
}

/** A Caveman engine sign-in: one click opens the provider's page and the row says what to do there. */
function SignInWay({ way, scan }: { way: Extract<Way, { kind: "sign_in" }>; scan: EngineScan }) {
  const { client } = useRuntimeClient();
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<SignInNote | null>(null);
  const start = () => {
    if (!client) return;
    setBusy(true);
    setNote(null);
    // The page opens in this click (startSignIn); what comes after is only said.
    startSignIn(client, way.provider)
      .then(
        (n) => setNote(n),
        (e) => setNote({ tone: "error", text: e instanceof Error ? e.message : String(e) }),
      )
      .finally(() => setBusy(false));
  };
  let panel: ReactNode = null;
  if (note || way.installCodex) {
    panel = (
      <div className={PANEL}>
        {note ? (
          <div className="flex flex-col gap-1.5">
            <p
              role={note.tone === "error" ? "alert" : "status"}
              className={note.tone === "error" ? "text-destructive" : "text-muted-foreground"}
            >
              {note.text}
            </p>
            {note.url ? (
              <a
                href={note.url}
                target="_blank"
                rel="noopener noreferrer"
                className="self-start text-[12.5px] font-medium text-foreground underline underline-offset-2"
              >
                Open the sign-in page
              </a>
            ) : null}
          </div>
        ) : null}
        {/* Codex runs on its own command, which is not on this computer: its install line, for anyone who wants it too. */}
        {way.installCodex ? (
          <div className={note ? "mt-3" : undefined}>
            <p className="mb-1.5 text-muted-foreground">Want Codex too?</p>
            <InstallHelp engine="codex" rescan={scan.rescan} />
          </div>
        ) : null}
      </div>
    );
  }
  return (
    <div>
      <Row
        icon={<SourceMark id={way.provider} label={way.label} size={14} />}
        label={way.label}
        desc={way.desc}
        right={
          <Button size="sm" variant="secondary" disabled={!client || busy} onClick={start}>
            {busy ? "Opening…" : note ? "Try again" : "Sign in"}
          </Button>
        }
      />
      {panel}
    </div>
  );
}
