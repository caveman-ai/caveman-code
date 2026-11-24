// A page's own alert, confirm, prompt or leave-page check in the agent's
// browser (browser.state `dialog`). The page, and input sent to it, wait until
// someone answers; only the window in control can.

import { Button } from "@caveman-app/ui/components/button";
import { Input } from "@caveman-app/ui/components/input";
import { useEffect, useState } from "react";
import type { BrowserState, LiveSource } from "../live/source.ts";

type Dialog = NonNullable<BrowserState["dialog"]>;

export function BrowserDialog({
  dialog,
  driving,
  source,
}: {
  readonly dialog: Dialog;
  readonly driving: boolean;
  readonly source: LiveSource<BrowserState>;
}) {
  const [text, setText] = useState(dialog.default_value);
  useEffect(() => setText(dialog.default_value), [dialog]);
  const answer = (accept: boolean) =>
    source.input({
      type: "dialog",
      accept,
      ...(accept && dialog.type === "prompt" ? { text } : {}),
    });
  const leaving = dialog.type === "beforeunload";
  const message = dialog.message || (leaving ? "Leave this page? Changes may not be saved." : "");

  return (
    <div
      role="alertdialog"
      aria-label="The page asks"
      className="absolute inset-x-3 top-3 z-20 mx-auto flex max-w-md flex-col gap-3 rounded-xl border border-border bg-popover p-3 text-[13px] shadow-overlay animate-in fade-in-0 slide-in-from-top-1 duration-200 ease-snap"
    >
      <p className="max-h-48 overflow-auto whitespace-pre-wrap break-words text-foreground">
        {message}
      </p>
      {driving ? (
        <form
          className="flex flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            answer(true);
          }}
          onKeyDown={(e) => {
            if (e.key !== "Escape") return;
            e.preventDefault();
            answer(false);
          }}
        >
          {dialog.type === "prompt" ? (
            <Input
              autoFocus
              aria-label="Answer"
              value={text}
              onChange={(e) => setText(e.target.value)}
            />
          ) : null}
          <div className="flex justify-end gap-2">
            {dialog.type === "alert" ? null : (
              <Button type="button" variant="secondary" size="sm" onClick={() => answer(false)}>
                {leaving ? "Stay" : "Cancel"}
              </Button>
            )}
            <Button type="submit" size="sm" autoFocus={dialog.type !== "prompt"}>
              {leaving ? "Leave" : "OK"}
            </Button>
          </div>
        </form>
      ) : (
        <p className="text-muted-foreground">Take over to answer.</p>
      )}
    </div>
  );
}
