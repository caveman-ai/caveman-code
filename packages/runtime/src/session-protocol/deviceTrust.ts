// Which devices This Mac trusts (docs/): the ones its own screen allowed (the
// roots), and the ones a Mac it trusts allowed for the person, through statements in the person's log that Cloud
// carries but cannot make. Pure: the same roots and statements give the same answer in any order.
//
// - Only a key of role "mac" signs a statement that counts (a browser's key, whose page Cloud serves, never does).
// - Removals first: R is every device a reachable Mac key removed, reachable ignoring removals, from the roots and from
//   the removers (This Mac's own key, and Macs its screen allowed and then removed), so a removed Mac's removals still
//   stand and an allow replayed after a removal changes nothing.
// - Then trust: the closure from the roots over allows by trusted Mac keys, never entering R. A Mac in R stops
//   counting, and devices trusted only through it drop.
// - This Mac's own screen has the last word here: what it blocked is never trusted, and the removals it lifted
//   (Unblock) count here no more for a device it allowed again. A later removal is a statement of its own and counts.
// - Agents keys (macMail.ts): one counts while a trusted Mac key vouched for it ("agents" statements), and neither it
//   nor that Mac is in R or blocked here. An agents key is never a device: a vouch adds nothing to trust.
import type { DeviceKind, DevicePublicKey, DeviceStatement } from "@caveman-app/session-protocol";

/** A device This Mac's own screen allowed. */
export interface TrustRoot {
  readonly device_id: string;
  readonly public_key: DevicePublicKey;
  readonly name: string;
  readonly role: DeviceKind;
}

/** Another of the person's Macs, as This Mac knows its key. */
export interface Signer {
  readonly device_id: string;
  readonly name: string;
}

export interface TrustedDevice {
  readonly device_id: string;
  readonly public_key: DevicePublicKey;
  readonly name: string;
  readonly role: DeviceKind;
  /** Absent: allowed on This Mac's screen. */
  readonly allowed_by?: Signer;
}

export interface RemovedDevice {
  readonly device_id: string;
  readonly name: string;
  readonly removed_by: Signer;
}

/** A Mac's agents key This Mac takes mail from: vouched for by a Mac key it trusts. */
export interface TrustedAgents {
  readonly device_id: string;
  readonly public_key: DevicePublicKey;
  /** The Mac that vouched for it, by the name This Mac knows it under ("<chat> on <name>"). */
  readonly vouched_by: Signer;
}

export interface Trust {
  readonly devices: ReadonlyMap<string, TrustedDevice>;
  /** Agents keys of the person's Macs This Mac trusts (never devices). */
  readonly agents: ReadonlyMap<string, TrustedAgents>;
  /** Devices a Mac This Mac takes removals from removed (not lifted here). */
  readonly removed: ReadonlyMap<string, RemovedDevice>;
  /** Devices such a Mac removed whose every removal this screen lifted (Unblock): they stand removed on the person's other Macs. */
  readonly lifted: ReadonlyMap<string, RemovedDevice>;
}

export interface TrustInput {
  readonly roots: ReadonlyArray<TrustRoot>;
  /** Verified statements (devices.ts take), in the order the log carried them. */
  readonly statements: ReadonlyArray<DeviceStatement>;
  /** The person This Mac's enrollment names: only their statements count. */
  readonly organizationId: string;
  readonly userId: string;
  /** Devices This Mac's screen blocked: never trusted here. */
  readonly blocked?: ReadonlyArray<string>;
  /**
   * Mac keys whose removals count here whatever trust says: This Mac's own desktop key, and Macs its screen allowed
   * and then removed (a removed Mac's removals still stand). Never trusted for that.
   */
  readonly removers?: ReadonlyArray<Signer>;
  /** Removals This Mac's screen lifted (Unblock), by removalKey: the device asks here again, and once allowed here counts here only. */
  readonly lifted?: ReadonlyArray<string>;
}

/** A removal as an Unblock names it, by fields its signature covers: the next removal of the same device is another. */
export const removalKey = (s: DeviceStatement) => `${s.device_id}:${s.signer.device_id}:${s.nonce}`;

/** Appends to a map's list in place (a flood of statements costs one pass, not a copy per statement). */
const add = <K, V>(map: Map<K, Array<V>>, key: K, value: V) => {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
};

/** The deterministic one of several statements: the least by signer, then nonce (order never decides). */
const pick = (statements: ReadonlyArray<DeviceStatement>) =>
  statements.reduce<DeviceStatement | undefined>((best, s) => (best === undefined || `${s.signer.device_id}\0${s.nonce}` < `${best.signer.device_id}\0${best.nonce}` ? s : best), undefined);

/**
 * The keys reachable from `starts` over allows signed by a reachable "mac" key, never entering `excluded`, with each
 * key's role: "mac" when a root or any counted allow says so (more allows only ever add).
 */
function closure(starts: ReadonlyMap<string, DeviceKind>, allowsBySigner: ReadonlyMap<string, ReadonlyArray<DeviceStatement>>, excluded: ReadonlySet<string>) {
  const role = new Map<string, DeviceKind>();
  for (const [id, kind] of starts) if (!excluded.has(id)) role.set(id, kind);
  const queue = [...role].filter(([, kind]) => kind === "mac").map(([id]) => id);
  while (queue.length > 0) {
    for (const s of allowsBySigner.get(queue.pop()!) ?? []) {
      if (excluded.has(s.device_id)) continue;
      const before = role.get(s.device_id);
      const after: DeviceKind = before === "mac" || s.role === "mac" ? "mac" : "device";
      if (before === after) continue;
      role.set(s.device_id, after);
      if (after === "mac") queue.push(s.device_id);
    }
  }
  return role;
}

/** Whom This Mac trusts, and whom a Mac it takes removals from removed. */
export function trusted(input: TrustInput): Trust {
  const mine = input.statements.filter((s) => s.organization_id === input.organizationId && s.user_id === input.userId);
  const blocked = new Set(input.blocked ?? []);
  const lifted = new Set(input.lifted ?? []);
  const roots = new Map(input.roots.filter((r) => !blocked.has(r.device_id)).map((r) => [r.device_id, r] as const));
  const removers = new Map((input.removers ?? []).map((r) => [r.device_id, r] as const));
  const allowsBySigner = new Map<string, Array<DeviceStatement>>();
  const allowsOf = new Map<string, Array<DeviceStatement>>();
  for (const s of mine) {
    if (s.kind !== "allow") continue;
    add(allowsBySigner, s.signer.device_id, s);
    add(allowsOf, s.device_id, s);
  }
  const startRoles = new Map([...roots.values()].map((r) => [r.device_id, r.role] as const));

  // Removals: by any Mac key reachable while ignoring removals, from the roots and the removers. A remover stays a Mac
  // here even when this screen allowed it again as a device.
  const reach = closure(new Map([...startRoles, ...[...removers.keys()].map((id) => [id, "mac"] as const)]), allowsBySigner, new Set());
  const removals = new Map<string, Array<DeviceStatement>>();
  for (const s of mine) if (s.kind === "remove" && reach.get(s.signer.device_id) === "mac") add(removals, s.device_id, s);
  /** The removals of a device that still stand here: every one this screen did not lift. */
  const standing = (id: string) => (removals.get(id) ?? []).filter((s) => !lifted.has(removalKey(s)));
  // A device whose every removal this screen lifted counts here once this screen allowed it again; never through another Mac.
  const excluded = new Set([...blocked, ...[...removals.keys()].filter((id) => !roots.has(id) || standing(id).length > 0)]);

  /** How This Mac names a key it reached: as its screen allowed it, else as the counted allow says. */
  const nameOf = (id: string, signers: ReadonlyMap<string, DeviceKind>) =>
    roots.get(id)?.name ?? removers.get(id)?.name ?? pick((allowsOf.get(id) ?? []).filter((s) => signers.get(s.signer.device_id) === "mac"))?.name;

  const trust = closure(startRoles, allowsBySigner, excluded);
  const devices = new Map<string, TrustedDevice>();
  for (const [id, role] of trust) {
    const root = roots.get(id);
    if (root) {
      devices.set(id, { device_id: id, public_key: root.public_key, name: root.name, role });
      continue;
    }
    const by = pick((allowsOf.get(id) ?? []).filter((s) => trust.get(s.signer.device_id) === "mac"))!;
    devices.set(id, { device_id: id, public_key: by.public_key!, name: by.name!, role, allowed_by: { device_id: by.signer.device_id, name: nameOf(by.signer.device_id, trust) ?? "a Mac" } });
  }
  const agents = new Map<string, TrustedAgents>();
  const vouches = new Map<string, Array<DeviceStatement>>();
  for (const s of mine) if (s.kind === "agents" && trust.get(s.signer.device_id) === "mac" && !excluded.has(s.device_id)) add(vouches, s.device_id, s);
  for (const [id, all] of vouches) {
    const by = pick(all)!;
    agents.set(id, { device_id: id, public_key: by.public_key!, vouched_by: { device_id: by.signer.device_id, name: nameOf(by.signer.device_id, trust) ?? "a Mac" } });
  }
  const removed = new Map<string, RemovedDevice>();
  const liftedHere = new Map<string, RemovedDevice>();
  for (const [id, all] of removals) {
    const still = standing(id);
    const by = pick(still.length > 0 ? still : all)!;
    (still.length > 0 ? removed : liftedHere).set(id, { device_id: id, name: nameOf(id, reach) ?? "A device", removed_by: { device_id: by.signer.device_id, name: nameOf(by.signer.device_id, reach) ?? "a Mac" } });
  }
  return { devices, agents, removed, lifted: liftedHere };
}
