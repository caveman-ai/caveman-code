// relay-device-trust, part 1 (.claude/skills/relay-device-trust/SKILL.md): whom This Mac trusts (deviceTrust.ts
// trusted), over every TrustInput built from a few keys, checked breadth-first with @caveman-app/model-check so a
// broken promise comes back as the smallest input that breaks it. Each step adds one thing This Mac's screen or the
// person's log can hold: a root, a statement, a block, a remover, or a lift.
import type { DeviceKind, DevicePublicKey, DeviceStatement } from "@caveman-app/session-protocol";
import { assertHolds, canonicalKey, check, type Step } from "@caveman-app/model-check";
import { test } from "vitest";

import { removalKey, trusted, type Trust, type TrustInput } from "./deviceTrust.ts";

const ORG = "org-1";
const ME = "user-1";

interface Built {
  /** Roots: devices This Mac's screen allowed, by key, with the role it allowed them as. */
  readonly roots: Readonly<Record<string, DeviceKind>>;
  /** Statement tokens, sorted (the log's order is a property of its own: `order never decides`). */
  readonly statements: ReadonlyArray<string>;
  readonly blocked: ReadonlyArray<string>;
  readonly removers: ReadonlyArray<string>;
  /** Removal tokens this screen lifted (Unblock). */
  readonly lifted: ReadonlyArray<string>;
}

const empty: Built = { roots: {}, statements: [], blocked: [], removers: [], lifted: [] };
const sortedWith = (list: ReadonlyArray<string>, item: string) => [...list, item].sort();

const keyOf = (id: string): DevicePublicKey => ({
  kty: "EC",
  crv: "P-256",
  x: `x-${id}`,
  y: `y-${id}`,
});

/**
 * A token as the verified statement devices.ts take hands trusted(): `allow S D role`, `remove S D n`, `agents S D`,
 * and `theirs allow|remove S D` (signed for another person). trusted() reads verified statements only, so the
 * signature is a placeholder; the nonce is the token's own, so every token is one statement.
 */
const statementOf = (token: string): DeviceStatement => {
  const parts = token.split(" ");
  const foreign = parts[0] === "theirs";
  const [kind, signer, device, extra] = foreign ? parts.slice(1) : parts;
  const base = {
    organization_id: ORG,
    user_id: foreign ? "user-2" : ME,
    device_id: device!,
    signer: { device_id: signer!, public_key: keyOf(signer!) },
    at: "2026-11-06T00:00:00.000Z",
    nonce: `nonce-${token.replaceAll(" ", "-")}`,
    signature: "verified",
  };
  if (kind === "allow")
    return {
      ...base,
      kind,
      public_key: keyOf(device!),
      name: `name ${device}`,
      role: (extra ?? "device") as DeviceKind,
    };
  if (kind === "agents")
    return { ...base, kind, public_key: keyOf(device!), name: `Mac ${signer}` };
  return { ...base, kind: "remove" };
};

const inputOf = (
  built: Built,
  order: (statements: Array<DeviceStatement>) => Array<DeviceStatement> = (s) => s,
): TrustInput => ({
  roots: Object.entries(built.roots).map(([id, role]) => ({
    device_id: id,
    public_key: keyOf(id),
    name: `root ${id}`,
    role,
  })),
  statements: order(built.statements.map(statementOf)),
  organizationId: ORG,
  userId: ME,
  blocked: built.blocked,
  removers: built.removers.map((id) => ({ device_id: id, name: `remover ${id}` })),
  lifted: built.lifted.map((token) => removalKey(statementOf(token))),
});

/** Each state's input and trust, computed once for all the invariants that read them. */
const evaluated = new WeakMap<Built, { readonly input: TrustInput; readonly trust: Trust }>();
const at = (built: Built) => {
  let known = evaluated.get(built);
  if (known === undefined) {
    const input = inputOf(built);
    known = { input, trust: trusted(input) };
    evaluated.set(built, known);
  }
  return known;
};

const views = new WeakMap<Trust, string>();
const view = (trust: Trust) => {
  let text = views.get(trust);
  if (text === undefined)
    views.set(
      trust,
      (text = canonicalKey({
        devices: trust.devices,
        agents: trust.agents,
        removed: trust.removed,
        lifted: trust.lifted,
      })),
    );
  return text;
};

const trustedText = (built: Built) => {
  try {
    return (
      [...at(built).trust.devices.values()].map((d) => `${d.device_id}:${d.role}`).join(" ") || "-"
    );
  } catch (error) {
    return `(trusted() threw: ${String(error)})`;
  }
};

const show = (built: Built) =>
  [
    `roots ${
      Object.entries(built.roots)
        .map(([id, role]) => `${id}:${role}`)
        .join(" ") || "-"
    }`,
    `statements ${built.statements.join(", ") || "-"}`,
    `blocked ${built.blocked.join(" ") || "-"}`,
    `removers ${built.removers.join(" ") || "-"}`,
    `lifted ${built.lifted.join(", ") || "-"}`,
    `trusted ${trustedText(built)}`,
  ].join(" | ");

/** The person's statements: the ones trust may read at all. */
const mine = (input: TrustInput) =>
  input.statements.filter(
    (s) => s.organization_id === input.organizationId && s.user_id === input.userId,
  );

/**
 * The property's own "reachable Mac key", for removals: from the roots this screen did not block and the removers
 * (TrustInput.removers: "Mac keys whose removals count here whatever trust says"), over the person's allows by a key
 * already reached as a Mac; a key is a Mac once anything that reaches it says so (deviceTrust closure: "more allows
 * only ever add"). Removals and blocks of reached keys do not stop it.
 */
const reachableMacs = (input: TrustInput) => {
  const blocked = new Set(input.blocked ?? []);
  const role = new Map<string, DeviceKind>();
  const raise = (id: string, kind: DeviceKind) => {
    if (role.get(id) === "mac" || role.get(id) === kind) return false;
    role.set(id, kind);
    return true;
  };
  for (const r of input.roots) if (!blocked.has(r.device_id)) raise(r.device_id, r.role);
  for (const r of input.removers ?? []) raise(r.device_id, "mac");
  const allows = mine(input).filter((s) => s.kind === "allow");
  for (let grew = true; grew;) {
    grew = false;
    for (const s of allows)
      if (role.get(s.signer.device_id) === "mac" && raise(s.device_id, s.role!)) grew = true;
  }
  return new Set([...role].filter(([, kind]) => kind === "mac").map(([id]) => id));
};

/** What the property lets trust hold of each key: blocked, removed (a standing removal), or free. */
const standing = (input: TrustInput) => {
  const reach = reachableMacs(input);
  const blocked = new Set(input.blocked ?? []);
  const lifted = new Set(input.lifted ?? []);
  const roots = new Set(
    input.roots.filter((r) => !blocked.has(r.device_id)).map((r) => r.device_id),
  );
  const removals = mine(input).filter((s) => s.kind === "remove" && reach.has(s.signer.device_id));
  /** Removed here: a reachable Mac key removed it, and it is not a root whose every such removal this screen lifted. */
  const removed = (id: string) => {
    const of = removals.filter((s) => s.device_id === id);
    return of.length > 0 && !(roots.has(id) && of.every((s) => lifted.has(removalKey(s))));
  };
  const free = (id: string) => !blocked.has(id) && !removed(id);
  return { reach, roots, removals, removed, free, blocked };
};

/**
 * Trust's devices are exactly the keys reached from its own roots over the person's allows signed by a key it holds
 * as a Mac, with the role those say: nothing it holds came from outside that closure.
 */
const grounded = (input: TrustInput, trust: Trust) => {
  const role = new Map<string, DeviceKind>();
  const raise = (id: string, kind: DeviceKind) => {
    if (role.get(id) === "mac" || role.get(id) === kind) return false;
    role.set(id, kind);
    return true;
  };
  for (const r of input.roots) if (trust.devices.has(r.device_id)) raise(r.device_id, r.role);
  const allows = mine(input).filter((s) => s.kind === "allow" && trust.devices.has(s.device_id));
  for (let grew = true; grew;) {
    grew = false;
    for (const s of allows)
      if (role.get(s.signer.device_id) === "mac" && raise(s.device_id, s.role!)) grew = true;
  }
  if (role.size !== trust.devices.size) return false;
  for (const [id, device] of trust.devices) {
    if (role.get(id) !== device.role) return false;
    const by = device.allowed_by?.device_id;
    if (
      by !== undefined &&
      !(
        trust.devices.get(by)?.role === "mac" &&
        allows.some((s) => s.device_id === id && s.signer.device_id === by)
      )
    )
      return false;
  }
  return true;
};

const drop = (built: Built, gone: (s: DeviceStatement) => boolean): Built => ({
  ...built,
  statements: built.statements.filter((token) => !gone(statementOf(token))),
});

const invariants: Readonly<Record<string, (built: Built) => boolean>> = {
  "a key this screen blocked is never trusted, as a device or as an agents key": (built) => {
    const trust = at(built).trust;
    return built.blocked.every((id) => !trust.devices.has(id) && !trust.agents.has(id));
  },
  "trust holds nothing outside the closure from its roots over allows by its own Mac keys": (
    built,
  ) => grounded(at(built).input, at(built).trust),
  "a standing removal by a reachable Mac key (a remover always is one) keeps its device out, except a root whose every removal this screen lifted":
    (built) => {
      const input = at(built).input;
      const trust = trusted(input);
      const { removed } = standing(input);
      return [...trust.devices.keys(), ...trust.agents.keys()].every((id) => !removed(id));
    },
  "a root this screen did not block, with no standing removal, is trusted": (built) => {
    const input = at(built).input;
    const trust = trusted(input);
    const { roots, free } = standing(input);
    return [...roots].every((id) => !free(id) || trust.devices.has(id));
  },
  "an allow (or vouch) by a Mac key trust holds brings in a free key, as a Mac when it says so": (
    built,
  ) => {
    const input = at(built).input;
    const trust = trusted(input);
    const { free } = standing(input);
    return mine(input).every((s) => {
      if (
        s.kind === "remove" ||
        trust.devices.get(s.signer.device_id)?.role !== "mac" ||
        !free(s.device_id)
      )
        return true;
      if (s.kind === "agents") return trust.agents.get(s.device_id) !== undefined;
      const got = trust.devices.get(s.device_id);
      return got !== undefined && (s.role !== "mac" || got.role === "mac");
    });
  },
  "an agents key counts only through a vouch by a Mac key trust holds": (built) => {
    const input = at(built).input;
    const trust = trusted(input);
    return [...trust.agents.values()].every((a) =>
      mine(input).some(
        (s) =>
          s.kind === "agents" &&
          s.device_id === a.device_id &&
          s.signer.device_id === a.vouched_by.device_id &&
          trust.devices.get(s.signer.device_id)?.role === "mac",
      ),
    );
  },
  "order never decides: the log reversed or rotated gives the same trust": (built) => {
    if (built.statements.length < 2) return true;
    const once = view(at(built).trust);
    return (
      once === view(trusted(inputOf(built, (s) => s.reverse()))) &&
      once === view(trusted(inputOf(built, (s) => [...s.slice(1), s[0]!])))
    );
  },
  "another person's statements change nothing": (built) => {
    const without = drop(built, (s) => s.user_id !== ME || s.organization_id !== ORG);
    return (
      without.statements.length === built.statements.length ||
      view(at(built).trust) === view(trusted(inputOf(without)))
    );
  },
  "statements by keys no reachable Mac key reaches change nothing": (built) => {
    const reach = reachableMacs(at(built).input);
    const without = drop(built, (s) => !reach.has(s.signer.device_id));
    return (
      without.statements.length === built.statements.length ||
      view(at(built).trust) === view(trusted(inputOf(without)))
    );
  },
  "a vouch never makes a device: the agents statements gone, devices and removals stay": (
    built,
  ) => {
    const without = drop(built, (s) => s.kind === "agents");
    if (without.statements.length === built.statements.length) return true;
    const [a, b] = [at(built).trust, trusted(inputOf(without))];
    return (
      canonicalKey([a.devices, a.removed, a.lifted]) ===
      canonicalKey([b.devices, b.removed, b.lifted])
    );
  },
};

interface Bound {
  readonly keys: ReadonlyArray<string>;
  /** Keys that only ever appear as an agents key. */
  readonly agentsKeys: ReadonlyArray<string>;
  readonly nonces: number;
  readonly theirs: boolean;
  readonly maxDepth: number;
}

/** Every way to add one thing to `built`: a step of the screen (roots, blocks, removers, lifts) or of the log. */
const nextOf =
  (bound: Bound) =>
  (built: Built): ReadonlyArray<Step<Built>> => {
    const steps: Array<Step<Built>> = [];
    const add = (action: string, state: Built) => steps.push({ action, state });
    const addStatement = (token: string) => {
      if (!built.statements.includes(token))
        add(`log: ${token}`, { ...built, statements: sortedWith(built.statements, token) });
    };
    for (const k of bound.keys) {
      if (built.roots[k] === undefined)
        for (const role of ["mac", "device"] as const)
          add(`screen allows ${k} as ${role}`, { ...built, roots: { ...built.roots, [k]: role } });
      if (!built.blocked.includes(k))
        add(`screen blocks ${k}`, { ...built, blocked: sortedWith(built.blocked, k) });
      if (!built.removers.includes(k))
        add(`${k} becomes a remover`, { ...built, removers: sortedWith(built.removers, k) });
      for (const d of bound.keys) {
        if (d === k) continue;
        for (const role of ["mac", "device"]) addStatement(`allow ${k} ${d} ${role}`);
        for (let n = 1; n <= bound.nonces; n++) addStatement(`remove ${k} ${d} ${n}`);
        if (bound.theirs) {
          addStatement(`theirs allow ${k} ${d} mac`);
          addStatement(`theirs remove ${k} ${d}`);
        }
      }
      for (const g of bound.agentsKeys) addStatement(`agents ${k} ${g}`);
    }
    for (const token of built.statements)
      if (token.startsWith("remove ") && !built.lifted.includes(token))
        add(`screen lifts ${token}`, { ...built, lifted: sortedWith(built.lifted, token) });
    return steps;
  };

/** A state's identity: its lists are kept sorted, so only the roots need ordering. */
const identityOf = (built: Built) =>
  `${Object.keys(built.roots)
    .sort()
    .map((id) => `${id}:${built.roots[id]}`)
    .join(
      " ",
    )}|${built.statements.join(",")}|${built.blocked.join(" ")}|${built.removers.join(" ")}|${built.lifted.join(",")}`;

const describe = (bound: Bound) =>
  `keys ${bound.keys.join("")}${bound.agentsKeys.length > 0 ? ` (agents key ${bound.agentsKeys.join("")})` : ""}, ${bound.nonces} removal nonce(s)${bound.theirs ? ", another person's statements" : ""}, every input of at most ${bound.maxDepth} steps`;

const run = (bound: Bound) => {
  const started = performance.now();
  const verdict = check<Built>({
    init: [empty],
    next: nextOf(bound),
    invariants,
    maxDepth: bound.maxDepth,
    key: identityOf,
  });
  const seconds = ((performance.now() - started) / 1000).toFixed(1);
  console.log(
    verdict.ok
      ? `relay-device-trust trusted() ${describe(bound)}: ${verdict.states} states, ${verdict.transitions} transitions, depth ${verdict.depth} (bounded by depth, not exhaustive beyond it), ${seconds} s`
      : `relay-device-trust trusted() ${describe(bound)}: "${verdict.property}" broken after ${verdict.states} states, ${seconds} s`,
  );
  return verdict;
};

/** `RDT_BOUNDS=keys:agentsKeys:nonces:theirs(0|1):depth,...` digs deeper than the per-change default. */
const BOUNDS: ReadonlyArray<Bound> = (process.env.RDT_BOUNDS ?? "AB:G:2:1:5,ABC::1:0:5")
  .split(",")
  .map((spec) => {
    const [keys, agents, nonces, theirs, depth] = spec.split(":");
    return {
      keys: [...keys!],
      agentsKeys: [...(agents ?? "")],
      nonces: Number(nonces),
      theirs: theirs === "1",
      maxDepth: Number(depth),
    };
  });

for (const bound of BOUNDS)
  test(`trusted() keeps every promise: ${describe(bound)}`, () => {
    assertHolds(run(bound), { show, requireExhaustive: false });
  });
