// Extension points other lanes fill in, with a real default so the method
// has a working call path before they land.
import type { SessionEvent } from "@caveman-app/session-protocol";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";

/**
 * The cheap side request behind message.caveman_version. Absent until an
 * engine lane provides one with a cheap model and a key; without it the
 * method answers engine_unavailable rather than inventing text.
 */
type Usage = Extract<SessionEvent, { type: "usage" }>["payload"];

export class CavemanRewriter extends Context.Reference<
  /** The rewritten text, and the call's usage (recorded as a runtime-level spend row). */
  { readonly rewrite: (text: string) => Effect.Effect<{ readonly text: string; readonly usage?: Usage | undefined }, Error> } | undefined
>("caveman/session-protocol/CavemanRewriter", { defaultValue: () => undefined }) {}

/**
 * Writes a SKILL.md from a session transcript (skill.record). Tests and other
 * embedders provide one; without it the runtime asks the Caveman engine with
 * the user's stored key, and without a key the method answers engine_unavailable.
 */
export class SkillWriter extends Context.Reference<
  | {
      /** The SKILL.md text, and the call's usage when it cost the user something (recorded as a runtime-level spend row). */
      readonly write: (input: { readonly transcript: string; readonly name?: string; readonly note?: string }) => Effect.Effect<
        { readonly text: string; readonly usage?: Usage | undefined },
        Error
      >;
    }
  | undefined
>("caveman/session-protocol/SkillWriter", { defaultValue: () => undefined }) {}
