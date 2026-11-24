// The rule's switch: whether a person's credentials stay outside this computer (cloud-computers SPEC decision 2,
// CONTRACT §2 "What never enters a Cloud computer"; README.md). On a boat computer the agent is root, so
// whatever the runtime holds, it holds too (finding S1). Under the rule the runtime asks Cloud for no sign-in token,
// engine key, account credential, connector lease or GitHub token: engines hold stand-ins and their model requests
// leave through Cloud's data plane, which attaches the real credential outside the computer (modelConnections.ts,
// secrets/EgressScrub.ts).
//
// Cloud says so in its answer to `GET runtime` (`credentials_outside: true`), asked once the link is up. False or
// absent (an older Cloud, and every Mac): everything works as before. Cloud refusing a credential route with
// `cave_code_outside_computer` says the same thing later (a Cloud that turned the rule on while this computer ran):
// the rule applies from that refusal on, so no caller asks twice.
//
// This is the one predicate. Whatever needs to know reads `CredentialRule.outside`: `ruleOf(link)` where a link's
// state is at hand, `credentialRule` (credentialsOutside.ts) from a fiber of the runtime. Every Cloud call's refusal
// passes `refusedBy` on its way out (computers.ts request).
import { CloudError } from "./identity.ts";
import type { LinkState } from "./index.ts";

/** Cloud's refusal of a credential route to a computer under the rule (CONTRACT §2). */
export const OUTSIDE_COMPUTER = "cave_code_outside_computer";

/** Where a person connects what their computers run on, as every refusal under the rule says it. */
export const CONNECT_WHERE = "Settings > Models & keys";

/** The agents whose Auto Cloud's data plane can route (Cloud's `routes_auto` names them). */
export type AutoAgent = "claude-agent" | "codex";

export class CredentialRule {
  #ask: (() => Promise<boolean>) | undefined;
  #known: boolean | undefined;
  /** `routes_auto` as Cloud last said it; undefined: not heard, or a Cloud from before the field. */
  #routesAuto: ReadonlySet<string> | undefined;
  #asking: Promise<boolean> | undefined;
  readonly #listeners = new Set<() => void>();

  /** On a Cloud computer: how Cloud is asked. A Mac's rule is never joined, and never applies. */
  join(ask: () => Promise<boolean>) {
    if (this.#ask !== undefined) return;
    this.#ask = ask;
    // At link-up, before anything asks for a credential: a failure is asked again by whoever needs the answer.
    void this.outside().catch(() => undefined);
  }

  /** Cloud's answer when it has been heard; undefined on a Cloud computer that has not heard yet. */
  known(): boolean | undefined {
    return this.#ask === undefined ? false : this.#known;
  }

  /**
   * Whether credentials stay outside this computer. On a Cloud computer the first call asks Cloud, and every call
   * until it answers shares that ask; when Cloud cannot be reached this rejects, and nothing that needs a credential
   * goes on: never a guess either way.
   */
  outside(): Promise<boolean> {
    if (this.#ask === undefined) return Promise.resolve(false);
    if (this.#known !== undefined) return Promise.resolve(this.#known);
    if (this.#asking !== undefined) return this.#asking;
    const asking = this.#ask().then((answer) => {
      // A refusal that arrived meanwhile already said so.
      if (this.#known === undefined) this.#set(answer);
      return this.#known!;
    });
    this.#asking = asking;
    void asking.then(
      () => this.#asking === asking && (this.#asking = undefined),
      () => this.#asking === asking && (this.#asking = undefined),
    );
    return asking;
  }

  /**
   * Whether `error` is Cloud refusing a credential route because the rule applies here. It does from then on: what
   * was held for attaching is dropped (onOutside), and no caller asks for a credential again.
   */
  refusedBy(error: unknown): boolean {
    if (!(error instanceof CloudError && error.status === 403 && error.code === OUTSIDE_COMPUTER))
      return false;
    if (this.#ask !== undefined && this.#known !== true) this.#set(true);
    return true;
  }

  /**
   * Cloud's `routes_auto` from the same answer: the agents whose Auto its data plane routes
   * for this computer. Anything but a list (an older Cloud says nothing) is none.
   */
  heardRoutesAuto(value: unknown) {
    this.#routesAuto = Array.isArray(value)
      ? new Set(value.filter((v): v is string => typeof v === "string"))
      : undefined;
  }

  /**
   * Whether Cloud's data plane routes `engine`'s Auto here: only under the rule, and only when Cloud named it. An older
   * Cloud names none, so Auto keeps its sentence there.
   */
  routesAuto(engine: string): boolean {
    return this.#known === true && this.#routesAuto?.has(engine) === true;
  }

  /** Hears the rule come on (at once when it already is): drop what was held for attaching. */
  onOutside(listener: () => void) {
    this.#listeners.add(listener);
    if (this.#known === true) listener();
  }

  #set(answer: boolean) {
    this.#known = answer;
    if (!answer) return;
    for (const listener of this.#listeners) {
      try {
        listener();
      } catch {
        // A listener's failure is its own.
      }
    }
  }
}

const rules = new WeakMap<LinkState, CredentialRule>();

/** The rule of the runtime whose link `link` is: one per runtime, like the link's state itself. */
export const ruleOf = (link: LinkState): CredentialRule => {
  let rule = rules.get(link);
  if (rule === undefined) rules.set(link, (rule = new CredentialRule()));
  return rule;
};

/** Where on the person's Mac something is done, as every refusal in Cloud says it: "on your Mac (Settings > Models & keys)". */
export const onYourMac = (place?: string) =>
  place === undefined ? "on your Mac" : `on your Mac (${place})`;

/** Where a person connects a connector, or gives a plugin's or a server's key, as every refusal in Cloud says it. */
export const PLUGINS_WHERE = "Plugins";

/** What a refused removal (a sign-out, a key's or an account's) says there: nothing was ever kept to remove. */
export const OUTSIDE_REMOVE = `Remove it ${onYourMac(CONNECT_WHERE)}.`;

/** What a refused reorder says there: the order is the person's, for all their computers. */
export const OUTSIDE_ORDER = `Change the order ${onYourMac(CONNECT_WHERE)}.`;

/** What a refused sign-in or added key says on a computer under the rule. */
export const OUTSIDE_CONNECT = `Connect it ${onYourMac(CONNECT_WHERE)}. It then works in Cloud too.`;

/** OUTSIDE_CONNECT, as its callers ask for it: what was refused (`what`) no longer changes the sentence. */
export const outsideMessage = (_what?: string) => OUTSIDE_CONNECT;

// The keys Cloud keeps no copy of to attach outside the computer: each refusal says what a chat there runs on
// instead, or where the key does work.

/** What a refused web search key says there (web.keys.set): the Caveman engine's searches run on credits. */
export const OUTSIDE_WEB_KEY = `Web search in Cloud runs on your credits. Your own key works ${onYourMac()}.`;

/** What a refused voice key says there (chief.voice.key). */
export const OUTSIDE_VOICE_KEY = `Add a voice key ${onYourMac("Settings > Chiefs")}.`;

/**
 * What a refused secret manager says there (secret_provider.save, and secret_slot.set pointing a setting at one):
 * connected, it would read the person's keys into the computer.
 */
export const OUTSIDE_SECRET_MANAGER = `Connect 1Password ${onYourMac("Settings > Secret providers")}.`;

/** What a server or marketplace whose command line or URL carries a key is answered there (mcp.add, marketplace.add). */
export const outsideLine = (what: "server" | "marketplace") =>
  `This ${what}'s ${what === "server" ? "command" : "URL"} holds a key, so add it ${onYourMac()}.`;

/** What a refused plugin or MCP server key says there (credential.grant). */
export const OUTSIDE_SERVER_KEY = `Add this key ${onYourMac(PLUGINS_WHERE)}.`;
