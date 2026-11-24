// Where web_fetch may connect (docs/ "Safety"): public unicast addresses only. The address is checked
// and pinned at connect time (undici's `connect.lookup`), so a name that resolves elsewhere a moment later (DNS
// rebinding) changes nothing; a literal IP never reaches a lookup, so `check` runs before every hop, redirects
// included. The address rules are the HTML preview's (htmlRender/publicProxy.ts), plus the few special ranges a
// browser proxy can ignore but a fetch should not.
// @effect-diagnostics nodeBuiltinImport:off - Effect has no address block list or lookup hook.
import * as NodeNet from "node:net";

import { Agent } from "undici";

import { isLocal, publicAddresses } from "../htmlRender/publicProxy.ts";

/** Ranges that are not public unicast and that isLocal leaves alone: documentation, benchmarking relays, discard. */
const NOT_PUBLIC = new NodeNet.BlockList();
for (const [network, prefix] of [
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
] as const) {
  NOT_PUBLIC.addSubnet(network, prefix, "ipv4");
}
// SIIT's IPv4-translated range is for translators inside a network, never a public host.
for (const [network, prefix] of [
  ["100::", 64],
  ["2001:db8::", 32],
  ["fec0::", 10],
  ["::ffff:0:0:0", 96],
] as const) {
  NOT_PUBLIC.addSubnet(network, prefix, "ipv6");
}

/** Whether a fetch may connect to `address`: public unicast, and not one this machine holds. */
export const isPublicUnicast = (address: string, family: number): boolean =>
  !isLocal(address, family) && !NOT_PUBLIC.check(address, family === 6 ? "ipv6" : "ipv4");

export class BlockedAddressError extends Error {
  readonly host: string;
  constructor(host: string) {
    super(`${host} is not a public address`);
    this.name = "BlockedAddressError";
    this.host = host;
  }
}

export interface ResolvedAddress {
  readonly address: string;
  readonly family: number;
}

export interface AddressGuard {
  /** Resolves `hostname` (a URL's, brackets and all) and fails with BlockedAddressError unless every address is public. */
  readonly check: (hostname: string) => Promise<void>;
  /** Connects only to addresses `check`'s rules allow, looked up again at connect time. */
  readonly dispatcher: Agent;
}

const bare = (hostname: string) => hostname.replace(/^\[|\]$/g, "");

/**
 * The guard web_fetch connects through. `resolve` and `allow` are for tests (a name that resolves to a metadata
 * address); by default a name resolves through the system resolver and must be public unicast.
 */
export function makeAddressGuard(options: {
  readonly resolve?: (host: string) => Promise<ReadonlyArray<ResolvedAddress>>;
  readonly allow?: (address: string, family: number) => boolean;
} = {}): AddressGuard {
  const allow = options.allow ?? isPublicUnicast;
  // publicAddresses already refuses a name with any local address; the stricter rule runs on what it returns.
  const resolve = options.resolve ?? (async (host: string) => (await publicAddresses(host)) ?? []);
  const addressesFor = async (hostname: string): Promise<ReadonlyArray<ResolvedAddress>> => {
    const host = bare(hostname);
    const family = NodeNet.isIP(host);
    const addresses = family !== 0 ? [{ address: host, family }] : await resolve(host);
    if (addresses.length === 0 || addresses.some(({ address, family }) => !allow(address, family))) throw new BlockedAddressError(host);
    return addresses;
  };
  const lookup = (
    hostname: string,
    lookupOptions: { readonly all?: boolean },
    callback: (error: Error | null, address: string | ReadonlyArray<ResolvedAddress>, family?: number) => void,
  ) => {
    addressesFor(hostname).then(
      (addresses) => (lookupOptions.all ? callback(null, addresses) : callback(null, addresses[0]!.address, addresses[0]!.family)),
      (error: Error) => callback(error, ""),
    );
  };
  return {
    check: (hostname) => addressesFor(hostname).then(() => undefined),
    // HTTP/1.1 only: an idle h2 session can throw outside any request (outboundHttp.ts).
    dispatcher: new Agent({ allowH2: false, connect: { lookup: lookup as never, timeout: 10_000 } }),
  };
}
