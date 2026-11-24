// The setup the first run brought over, when it didn't all come (some failed, it failed, or the app closed first):
// bring the rest. What's left is read fresh, so what did come over is never brought twice.
import { useEffect, useState } from "react";
import { QuietButton } from "../../panels/chrome.tsx";
import { useRuntimeClient } from "../../state/runtime.tsx";
import { forgetBringing, onBringingFinished, startBringing, useBringing } from "../../state/setup-import.ts";
import { bringingLine, bringingUnfinished, importRefs, importSummary } from "../onboarding/model.ts";
import { message } from "./shared.tsx";

export function SetupLeftOver({ onChanged }: { onChanged: () => void }) {
  const { client } = useRuntimeClient();
  const bringing = useBringing();
  const [problem, setProblem] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  // A run finishing while this page is open changes what's installed.
  useEffect(() => onBringingFinished(onChanged), [onChanged]);
  if (!bringing || !(bringingUnfinished(bringing) || bringing.state === "running")) return null;
  const running = bringing.state === "running";
  const rest = () => {
    if (!client) return;
    setChecking(true);
    setProblem(null);
    client.call("import.scan", {}).then(
      (r) => {
        setChecking(false);
        const items = importRefs(r.sources);
        if (items.length === 0) {
          forgetBringing();
          onChanged();
          return;
        }
        startBringing(client, items, importSummary(r.sources).parts, true);
      },
      (e: unknown) => {
        setChecking(false);
        setProblem(message(e));
      },
    );
  };
  return (
    <p role="status" className={`flex items-center gap-2 text-[12.5px] ${running ? "text-muted-foreground" : "text-warning"}`}>
      <span className="min-w-0 flex-1 truncate" title={problem ?? undefined}>
        {problem ? `Couldn't check what's left: ${problem}` : bringingLine(bringing)}
      </span>
      {running ? null : (
        <>
          <QuietButton onClick={rest}>{checking ? "Checking…" : "Bring the rest"}</QuietButton>
          <QuietButton onClick={forgetBringing}>Dismiss</QuietButton>
        </>
      )}
    </p>
  );
}
