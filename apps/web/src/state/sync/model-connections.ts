// The person's connections in Caveman Cloud, from a device that holds their own Cloud session (cloud-computers
// CONTRACT section 4: GET, POST, PATCH and DELETE model-connections). A Cloud computer's runtime lists them and may
// change none, so a page attached to one writes here itself: the web build on its cookie, the desktop on the token
// its own runtime mints. No answer carries a credential, and the one a person pastes is sent once and kept nowhere.
import type { AccountConnection } from "@caveman-app/session-protocol";
import { CloudError, cloudRequester, type CloudAuth } from "./cloud-api.ts";

/** What the list and adding to it say on a Cloud from before connections (no route for them), in place of its own sentence. */
const CLOUD_LACKS_CONNECTIONS = "Your Caveman Cloud needs an update before it can connect plans.";
/** What a route that names a connection says when Cloud does not have it (Cloud's own sentence, whatever it sent). */
const CONNECTION_NOT_FOUND = "Connection not found.";
const notFound = (error: unknown): error is CloudError =>
  error instanceof CloudError && error.status === 404 && error.code === "cave_not_found";

/** One of the person's connections as Cloud lists it: never a credential. */
export interface CloudConnection {
  readonly id: string;
  readonly kind: AccountConnection["kind"];
  readonly provider: string;
  readonly label: string;
  /** Position 0 is tried first. */
  readonly position: number;
  readonly status: AccountConnection["status"];
  readonly used_up_until?: string | null;
  readonly expires_at?: string | null;
  /** The engines it can pay for, by the app's engine id. */
  readonly serves: ReadonlyArray<string>;
}
export interface CloudConnectionList {
  readonly connections: ReadonlyArray<CloudConnection>;
  /** A kind whose switch is off is listed and not used; a kind left out is on. */
  readonly kinds?: Partial<Record<AccountConnection["kind"], { readonly on: boolean }>>;
}

/** The person's whole order with `id` first: what Cloud's order route takes (every connection's id once). */
export const orderWithFirst = (ids: ReadonlyArray<string>, id: string): string[] =>
  ids.includes(id) ? [id, ...ids.filter((other) => other !== id)] : [...ids];

export interface CloudConnections {
  list(): Promise<CloudConnectionList>;
  /** Connects a Claude plan from the line `claude setup-token` printed. */
  addClaudePlan(token: string): Promise<CloudConnectionList>;
  /** Moves a connection to the front of the person's order. */
  moveToTop(id: string): Promise<CloudConnectionList>;
  /** Removes a connection from every computer of the person's. */
  remove(id: string): Promise<CloudConnectionList>;
}

const ROUTE = "/api/v1/code/model-connections";

export function cloudConnections(
  auth: CloudAuth,
  fetchImpl: typeof fetch = fetch,
): CloudConnections {
  const asked = cloudRequester(auth, fetchImpl);
  // Cloud answers 404 cave_not_found both for a route it does not have and for a connection that is not there. The
  // list and adding to it name no connection, so there it is the route: a Cloud from before connections. Anywhere else
  // it is the connection named.
  const saying =
    (sentence: string): typeof asked =>
    (path, init, signal) =>
      asked(path, init, signal).catch((error: unknown) => {
        throw notFound(error) ? new CloudError(404, error.code, sentence) : error;
      });
  const collection = saying(CLOUD_LACKS_CONNECTIONS);
  const named = saying(CONNECTION_NOT_FOUND);
  const list = async () => (await collection(ROUTE)).json() as Promise<CloudConnectionList>;
  return {
    list,
    addClaudePlan: async (token) => {
      await collection(ROUTE, {
        method: "POST",
        body: JSON.stringify({ kind: "claude_plan", token }),
      });
      return list();
    },
    moveToTop: async (id) => {
      // Cloud takes the whole order: every connection's id once, as it lists them now.
      const ids = [...(await list()).connections]
        .sort((a, b) => a.position - b.position)
        .map((c) => c.id);
      await named(`${ROUTE}/order`, {
        method: "PATCH",
        body: JSON.stringify({ ids: orderWithFirst(ids, id) }),
      });
      return list();
    },
    remove: async (id) => {
      await named(`${ROUTE}/${encodeURIComponent(id)}`, { method: "DELETE" });
      return list();
    },
  };
}
