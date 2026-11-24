// Git, which adding a project and every chat's worktree need (git.installed). A Mac without Apple's Command Line Tools
// has only a stub that asks to install them; a Windows without Git for Windows has no git, nor the bash Claude Code and
// the Caveman engine run commands in. Your setup shows the Tools card when git is missing, and on Windows when it is
// there too (docs/, Your setup); the project step shows it while git is missing. It says what to
// do, starts Apple's installer or opens Git for Windows' page, and turns ready by itself once git runs.

import { Button } from "@caveman-app/ui/components/button";
import { Copy01Icon, Icon, Tick02Icon } from "@caveman-app/ui/icons/huge";
import { useState } from "react";

import { openExternal } from "../../panels/browser/BrowserBar.tsx";
import { requestId, useRuntimeClient } from "../../state/runtime.tsx";
import { useGitInstalled } from "./data.ts";
import { Card, Ready, Row } from "./parts.tsx";
import { Glyph } from "@caveman-app/ui/icons/Glyph";

export function GitTools({ showReady = false }: { showReady?: boolean }) {
  const { client } = useRuntimeClient();
  const { installed } = useGitInstalled();
  const [started, setStarted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  if (installed === null || (installed.ready && !showReady)) return null;
  const install = installed.install;
  const start = () => {
    if (!client) return;
    setError(null);
    client.call("git.install", { request_id: requestId() }).then(
      () => setStarted(true),
      (e) => setError(e instanceof Error ? e.message : String(e)),
    );
  };
  const copy = (command: string) =>
    void navigator.clipboard.writeText(command).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  return (
    <Card title="Tools">
      <Row
        icon={<Glyph name="artifact-terminal" />}
        label="Git"
        desc={installed.ready ? `Version ${installed.version ?? ""}`.trim() : started ? "Finish in Apple's installer; this updates by itself" : "Not ready"}
        right={
          installed.ready ? (
            <Ready />
          ) : (
            <>
              {install?.command ? (
                <Button size="sm" variant="ghost" aria-label={`Copy ${install.command}`} title={`Copy ${install.command}`} onClick={() => copy(install.command!)}>
                  <Icon icon={copied ? Tick02Icon : Copy01Icon} className="size-3.5" />
                </Button>
              ) : null}
              {install?.runs ? (
                <Button size="sm" variant="secondary" onClick={start}>
                  {started ? "Open again" : install.label}
                </Button>
              ) : install?.url ? (
                <Button size="sm" variant="secondary" onClick={() => openExternal(install.url!)}>
                  {install.label}
                </Button>
              ) : null}
            </>
          )
        }
      />
      {!installed.ready && (error ?? installed.problem) ? (
        <p role={error ? "alert" : undefined} className={error ? "px-2.5 pb-2 text-[12.5px] leading-[18px] text-destructive" : "px-2.5 pb-2 text-[12.5px] leading-[18px] text-muted-foreground"}>
          {error ?? installed.problem}
        </p>
      ) : null}
    </Card>
  );
}
