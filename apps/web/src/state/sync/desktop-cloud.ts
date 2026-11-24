// The desktop's way to Caveman Cloud (S6): its renderer never holds the person's Cloud sign-in. It asks This Mac's
// runtime for a short-lived bearer (cloud.client_token, minted from the runtime's own sign-in, never its refresh
// token) and uses it for the chat list and for the relay to Cloud computers, asking again before it expires.
import type { Client } from "@caveman-app/session-protocol/client";
import type { CloudAuth } from "./cloud-api.ts";
import type { PoolEndpoint } from "./runtime-pool.ts";
import type { ClientToken } from "./wire.ts";
import { THIS_COMPUTER } from "../../lib/platform.ts";

/** Ask for a new token this long before the one held expires. */
const EARLY_MS = 60_000;

/**
 * Who This Mac's runtime is signed in to Cloud as, for the desktop's part of the device store (F-1): its enrollment,
 * which Cloud makes for one person in one org at each sign-in. Null when it is not signed in.
 */
export function desktopPerson(cloud: { readonly cloud_url?: string; readonly runtime_id?: string }): string | null {
  return cloud.runtime_id ? `${cloud.cloud_url ?? ""} ${cloud.runtime_id}` : null;
}

export class DesktopCloudToken {
  private current: ClientToken | null = null;
  private asking: Promise<ClientToken> | null = null;
  private readonly client: () => Client | null;
  private readonly now: () => number;

  constructor(client: () => Client | null, now: () => number = Date.now) {
    this.client = client;
    this.now = now;
  }

  /** The token held, if it is still good: for the synchronous parts (the relay URL). */
  held(): ClientToken | null {
    return this.current;
  }

  async get(): Promise<ClientToken> {
    if (this.current && Date.parse(this.current.expires_at) - this.now() > EARLY_MS) return this.current;
    this.asking ??= (async () => {
      const client = this.client();
      if (!client) throw new Error(`${THIS_COMPUTER}'s runtime is not connected.`);
      try {
        return (this.current = await client.call("cloud.client_token", {}, { timeoutMs: 15_000 }));
      } finally {
        this.asking = null;
      }
    })();
    return this.asking;
  }

  invalidate(): void {
    this.current = null;
  }

  /** Bearer auth for Cloud's chat routes, at Cloud's own origin (the token says which). */
  auth(): CloudAuth {
    const token = this;
    return {
      get base() {
        return token.held()?.api_url ?? "";
      },
      headers: async () => ({ authorization: `Bearer ${(await token.get()).token}` }),
      renew: async () => {
        token.invalidate();
        return token.get().then(
          () => true,
          () => false,
        );
      },
      credentials: "omit",
    };
  }

  /** A runtime on another computer, through Cloud's relay, on this token. Null until a token is held. */
  endpoint(runtimeId: string): PoolEndpoint | null {
    const held = this.held();
    if (!held) return null;
    return { url: `${held.relay_url.replace(/\/+$/, "")}/${encodeURIComponent(runtimeId)}`, token: async () => (await this.get()).token };
  }
}
