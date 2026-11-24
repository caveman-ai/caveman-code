// Version skew between this client and a runtime it talks to (session-protocol revision.ts): which one, and the one
// sentence that says what to do. Features never gate on versions; they gate on runtime.hello's capabilities.
import { versionSkew, type RuntimeHello, type VersionSkew } from "@caveman-app/session-protocol";

/** A runtime this window talks to whose Caveman Code does not work with this client's. */
export interface SkewedRuntime {
  readonly skew: VersionSkew;
  /** Its computer, as Cloud's list or this window names it. */
  readonly name: string;
  readonly kind: "cloud" | "laptop";
  /** A Cloud computer's id, for Update now (Cloud moves it onto the install's current image). */
  readonly computerId?: string;
}

/** The first runtime whose answer is skewed, in the order given (this window's own runtime first). */
export function firstSkewed(
  runtimes: ReadonlyArray<{
    readonly hello: RuntimeHello | undefined;
    readonly name: string;
    readonly kind: "cloud" | "laptop";
    readonly computerId?: string | undefined;
  }>,
): SkewedRuntime | null {
  for (const r of runtimes) {
    const skew = r.hello ? versionSkew(r.hello) : null;
    if (skew)
      return {
        skew,
        name: r.name,
        kind: r.kind,
        ...(r.computerId ? { computerId: r.computerId } : {}),
      };
  }
  return null;
}

/**
 * One sentence each. An older Cloud computer updates when it wakes, or at once with Update now; an older Mac updates
 * itself there. A newer runtime asks for this app's update, or, in a browser, a reload (Cloud may serve a newer page).
 */
export function skewSentence(s: SkewedRuntime, desktop: boolean): string {
  const self = desktop ? "this app" : "this page";
  if (s.skew === "runtime_older") {
    return s.kind === "cloud"
      ? `${s.name} runs an older Caveman Code than ${self} needs; it updates the next time it wakes, or now.`
      : `${s.name} runs an older Caveman Code than ${self} needs; update Caveman Code on it.`;
  }
  return desktop
    ? `${s.name} runs a newer Caveman Code than this app; update the app to keep working with it.`
    : `${s.name} runs a newer Caveman Code than this page; reload it, or use the Caveman Code app.`;
}
