// The desktop tab on a Cloud computer whose image predates the desktop. Cloud moves a sleeping computer onto the
// install's current image when it wakes, so it gets one then; Update now asks Cloud to do it at once (an idle
// computer restarts on the new image, a busy one at its next wake), from any device that reaches Cloud's routes.
// The window's notice for a Cloud computer older than this client needs uses the same Update now (useUpdateNow).
import { useState } from "react";
import { QuietButton, SurfaceEmpty } from "../chrome.tsx";

type Step = { readonly step: "idle" | "asking" | "asked" } | { readonly step: "failed"; readonly message: string };

/**
 * Update now for one Cloud computer: `ask` is undefined where it can't be offered (no computer, or a device that
 * can't reach Cloud's routes), or once asked.
 */
export function useUpdateNow(computerId: string | undefined, update: ((computerId: string) => Promise<unknown>) | undefined) {
  const [state, setState] = useState<Step>({ step: "idle" });
  const ask =
    update !== undefined && computerId !== undefined && state.step !== "asked"
      ? () => {
          setState({ step: "asking" });
          update(computerId).then(
            () => setState({ step: "asked" }),
            (error: unknown) => setState({ step: "failed", message: error instanceof Error ? error.message : String(error) }),
          );
        }
      : undefined;
  return { state, ask };
}

export function OlderImage({
  computerId,
  update,
}: {
  computerId: string | undefined;
  /** Cloud's update for this device (CloudApi.update: the web's cookie or the desktop's token); none, no button. */
  update: ((computerId: string) => Promise<unknown>) | undefined;
}) {
  const { state, ask } = useUpdateNow(computerId, update);
  const action = ask ? (
    <QuietButton onClick={ask} disabled={state.step === "asking"}>
      {state.step === "asking" ? "Updating" : "Update now"}
    </QuietButton>
  ) : undefined;
  return (
    <SurfaceEmpty title="This computer has no desktop yet" action={action}>
      {state.step === "asked"
        ? "It restarts on the new image when it is idle. This tab comes back once it does."
        : state.step === "failed"
          ? state.message
          : "Its image predates the desktop. It updates the next time it wakes."}
    </SurfaceEmpty>
  );
}
