// Harness engines: upstream other drivers (packages/provider-<id>), one Session Protocol
// engine per driver. The engine id is the driver kind; its accounts are the driver's
// instances, the default `<driver>` and further `<driver>-account-*` ones.
import type { EngineProvider } from "@caveman-app/session-protocol";
import type { ProviderClientDefinition } from "@caveman-app/engine-core/client";
import { cursorClient } from "@caveman-app/provider-cursor/client";
import { antigravityClient } from "../provider/antigravityClient.ts";
import { piClient } from "@caveman-app/provider-pi/client";
import { grokClient } from "@caveman-app/provider-grok/client";
import { museClient } from "@caveman-app/provider-muse/client";
import { openCodeClient } from "@caveman-app/provider-opencode/client";
import * as Schema from "effect/Schema";

interface Harness {
  readonly client: ProviderClientDefinition;
 /** A login through the harness's own CLI; absent where the app runs the sign-in itself (native browser sign-in). */
  readonly cliSignIn?: { readonly command: string; readonly message: string };
  /** The environment variable an engine.account.add `key` goes into. */
  readonly keyEnv?: string;
  /**
   * The variable that moves its CLI login to a home of its own, so a second keyless account signs
   * in apart from the first (the default instance keeps the person's own). Without one, a second
   * account needs a key.
   */
  readonly cliHome?: string;
  /** Whether its model traffic can go through the app's caveman-proxy (EngineDescriptor.capabilities.proxy). */
  readonly proxy: boolean;
  /** Narrows `proxy` to one instance: its version, its own settings, whether the egress scrub is up. */
  readonly proxyWhen?: (instance: HarnessInstance) => boolean;
  /**
   * A folder in the home folder that says it is on this computer, for a harness whose probe always finds it
 * (engine.scan): native SDK ships with the app, so only ~/.cursor says the person uses Cursor.
   */
  readonly homeMarker?: string;
}

export interface HarnessInstance {
  readonly version: string | null | undefined;
  readonly config: Readonly<Record<string, unknown>> | undefined;
  readonly scrubUp: boolean;
}

/** Whether this instance's traffic goes through the app's caveman-proxy. */
export const harnessProxies = (engine: string, instance: HarnessInstance): boolean => {
  const harness = HARNESSES.get(engine);
  return harness !== undefined && harness.proxy && (harness.proxyWhen?.(instance) ?? true);
};

export const HARNESSES: ReadonlyMap<string, Harness> = new Map<string, Harness>([
 // native agent runs its models in native cloud; the SDK only talks to api2.cursor.sh.
  ["cursor", { client: cursorClient, keyEnv: "CURSOR_API_KEY", proxy: false, homeMarker: ".cursor" }],
  // OpenCode 2's Anthropic and OpenAI providers go through the app's caveman-proxy (EngineEgress.routeOpenCodeEnvironment).
  [
    "opencode",
    {
      client: openCodeClient,
      cliSignIn: {
        command: "opencode auth login",
        message: "Run opencode auth login in a terminal and pick your provider there. Caveman Code never sees those credentials: OpenCode keeps its own logins.",
      },
      // OpenCode keeps its logins in $XDG_DATA_HOME/opencode/auth.json.
      cliHome: "XDG_DATA_HOME",
      proxy: true,
      // Routed only on an OpenCode 2 server this runtime starts (EngineEgress.layerOpenCodeEgress), while the scrub is up.
      proxyWhen: ({ version, config, scrubUp }) =>
        scrubUp && Number(version?.replace(/^v/, "").split(".")[0]) >= 2 && !(typeof config?.serverUrl === "string" && config.serverUrl.trim() !== ""),
    },
  ],
  // Muse Code (Meta) runs its models on Meta's service over its own login; it takes no base URL.
  [
    "muse",
    {
      client: museClient,
      cliSignIn: {
        command: "muse login",
        message: "Run muse login in a terminal and sign in there. Caveman Code never sees your Muse credentials: Muse Code runs on its own login.",
      },
      proxy: false,
    },
  ],
  // Grok's CLI talks to xAI's own chat proxy (cli-chat-proxy.grok.com) on its own login; the
  // caveman-proxy has no route for it, so nothing on this computer can shorten its traffic.
  ["grok", {
    client: grokClient,
    keyEnv: "XAI_API_KEY",
    cliSignIn: {
      command: "grok login",
      message: "Run grok login in a terminal and sign in there. Caveman Code never sees your Grok credentials: Grok runs on its own login and your plan's limits.",
    },
    proxy: false,
  }],
  // Stock Pi (not the Caveman engine). Its endpoints are per provider in the user's own Pi
  // config, often an OAuth plan; caveman v4's Pi extension routes only the person's own proxy.
  ["pi", {
    client: piClient,
    cliSignIn: {
      command: "pi",
      message: "Run pi in a terminal and sign in there (/login), or set an API key in ~/.pi/agent. Caveman Code never sees your Pi credentials.",
    },
    // Pi keeps its logins in its agent directory.
    cliHome: "PI_CODING_AGENT_DIR",
    proxy: false,
  }],
  // Google's Antigravity ACP server: a Google sign-in in the browser (or a Gemini or Vertex key in
  // its settings) against Google's Code Assist service, which no base URL redirects.
  ["antigravity", { client: antigravityClient, proxy: false }],
]);

export const HARNESS_ENGINES: ReadonlySet<string> = new Set(HARNESSES.keys());
export const HARNESS_ACCOUNT_INFIX = "-account-";

/** The harness engine an instance id belongs to, if any. */
export const harnessEngineOf = (instanceId: string): string | undefined => {
  const base = instanceId.split(HARNESS_ACCOUNT_INFIX)[0]!;
  return HARNESS_ENGINES.has(base) ? base : undefined;
};

/** engine.providers' one entry for a harness: the add-account form, from the driver's own settings schema. */
export function harnessProvider(engine: string): EngineProvider | undefined {
  const harness = HARNESSES.get(engine);
  if (harness === undefined) return undefined;
  const schema = harness.client.settingsSchema;
  const order = Schema.resolveAnnotations(schema)?.providerSettingsFormSchema?.order ?? Object.keys(schema.fields);
  const fields = order.flatMap((name) => {
    const field = schema.fields[name];
    const notes = field === undefined ? undefined : (Schema.resolveAnnotationsKey(field) ?? Schema.resolveAnnotations(field));
    const form = notes?.providerSettingsForm;
    if (form?.hidden === true || form?.control === "switch" || typeof notes?.title !== "string") return [];
    return [
      {
        name,
        label: notes.title,
        ...(form?.placeholder ? { placeholder: form.placeholder } : {}),
        optional: true,
        ...(form?.control === "select" && form.options ? { options: form.options.map((o) => ({ value: o.value, label: o.label })) } : {}),
      },
    ];
  });
  const keyField = harness.client.environmentFields?.find((f) => f.name === harness.keyEnv);
  return {
    id: engine,
    label: harness.client.label,
    group: "featured",
    auth: keyField ? "optional_key" : "cli",
    ...(keyField ? { key_label: keyField.label } : {}),
    ...(fields.length > 0 ? { fields } : {}),
    ...(harness.cliSignIn === undefined ? { sign_in: true } : {}),
  };
}

/** A tag made from an account's label: the initials of its first two words, or its first two letters. */
export const defaultAccountTag = (label: string): string => {
  const words = label.split("@")[0]!.split(/[^A-Za-z0-9]+/).filter(Boolean);
  const tag = words.length >= 2 ? `${words[0]![0]}${words[1]![0]}` : (words[0] ?? "").slice(0, 2);
  return tag.length === 2 ? tag.toUpperCase() : "AC";
};

/**
 * Tags for one engine's accounts: each keeps the one it has (`kept`), and an account without one
 * gets its label's tag, numbered past any already taken (JO, JO2, JO3). Answers the new ones.
 */
export const assignAccountTags = (
  accounts: ReadonlyArray<{ readonly id: string; readonly label: string }>,
  kept: Readonly<Record<string, string>>,
): Record<string, string> => {
  const taken = new Set(accounts.flatMap((a) => (kept[a.id] ? [kept[a.id]!] : [])));
  const fresh: Record<string, string> = {};
  for (const account of accounts) {
    if (kept[account.id]) continue;
    const base = defaultAccountTag(account.label);
    // ponytail: numbers 2-9; a tenth account with the same initials shares a tag.
    const tag = [base, ...[2, 3, 4, 5, 6, 7, 8, 9].map((n) => `${base}${n}`)].find((t) => !taken.has(t)) ?? base;
    taken.add(tag);
    fresh[account.id] = tag;
  }
  return fresh;
};
