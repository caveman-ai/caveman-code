import { expect, test } from "vitest";

import type { Profile, ProfileSkill } from "./profile.ts";
import {
  assemble,
  heldItem,
  itemsOf,
  keyOf,
  merge,
  MAX_SKILL_REMOVALS,
  skillProblem,
  type Base,
  type LocalItem,
  type MergeInput,
  type SyncItem,
} from "./profileMerge.ts";

const skill = (name: string, body = `# ${name}\n`): ProfileSkill => ({
  name,
  source: "claude-home",
  files: [{ path: "SKILL.md", content: body }],
});
const profile = (p: {
  skills?: ProfileSkill[];
  installed?: Array<{ id: string; enabled?: boolean }>;
  servers?: Array<{ name: string; command: string; cloudConsent?: boolean }>;
}): Profile => ({
  version: 2,
  plugins: {
    spaces: [],
    disabled: [],
    servers: (p.servers ?? []).map((s) => ({
      ...s,
      source: "manual" as const,
      enabled: true,
      cloud: "runs" as const,
    })),
    installed: (p.installed ?? []).map((i) => ({ ...i, cloud: "runs" as const })),
    trustedHooks: [],
  },
  skills: p.skills ?? [],
});
const items = (p: Parameters<typeof profile>[0]) => itemsOf(profile(p)) as Map<string, LocalItem>;
/** The bases two sides agreed on when both were `p`. */
const agreed = (p: Parameters<typeof profile>[0]) =>
  new Map<string, Base>(
    [...itemsOf(profile(p))].map(([k, i]) => [k, { l: i.digest, r: i.digest }]),
  );
const run = (input: Partial<MergeInput> & Pick<MergeInput, "local" | "remote">) =>
  merge({
    bases: new Map(),
    fresh: false,
    apply: true,
    blocked: () => undefined,
    lineage: "a".repeat(32),
    ...input,
  });
const names = (p: Profile) => p.skills.map((s) => s.name);
const S = (name: string) => keyOf("skill", name);

test("one side's change goes to the other: an add or edit here goes to Cloud, and Cloud's is taken here", () => {
  const was = { skills: [skill("a"), skill("b")] };
  const out = run({
    bases: agreed(was),
    local: items({ skills: [skill("a", "# a, edited here\n"), skill("b"), skill("c")] }),
    remote: itemsOf(
      profile({ skills: [skill("a"), skill("b", "# b, edited elsewhere\n"), skill("d")] }),
    ),
  });
  expect(names(out.profile)).toEqual(["a", "b", "c", "d"]);
  expect(out.profile.skills.find((s) => s.name === "a")!.files[0]!.content).toBe(
    "# a, edited here\n",
  );
  expect(
    out.takes.map((t) => [t.key, t.to === undefined ? "remove" : "write", t.conflict]),
  ).toEqual([
    [S("b"), "write", false],
    [S("d"), "write", false],
  ]);
  expect(out.profile).toMatchObject({ version: 3, lineage: "a".repeat(32) });
});

test("a removal on either side goes to the other; an edit beats a removal", () => {
  const was = {
    skills: [skill("gone-here"), skill("gone-there"), skill("edited-there"), skill("edited-here")],
  };
  const out = run({
    bases: agreed(was),
    // Here: gone-here removed, edited-here edited, edited-there removed.
    local: items({ skills: [skill("gone-there"), skill("edited-here", "# mine\n")] }),
    // Cloud: gone-there removed, edited-there edited, edited-here removed.
    remote: itemsOf(profile({ skills: [skill("gone-here"), skill("edited-there", "# theirs\n")] })),
  });
  expect(names(out.profile)).toEqual(["edited-here", "edited-there"]);
  expect(out.takes.map((t) => [t.key, t.to === undefined ? "remove" : "write"])).toEqual([
    [S("edited-there"), "write"],
    [S("gone-there"), "remove"],
  ]);
  expect(out.notes.get(S("edited-there"))).toMatch(/back/);
});

test("two edits at once keep Cloud's, as the person's other settings do, and say the local one went to the trash", () => {
  const was = { skills: [skill("a")] };
  const out = run({
    bases: agreed(was),
    local: items({ skills: [skill("a", "# mine\n")] }),
    remote: itemsOf(profile({ skills: [skill("a", "# theirs\n")] })),
  });
  expect(out.profile.skills[0]!.files[0]!.content).toBe("# theirs\n");
  expect(out.takes).toMatchObject([{ key: S("a"), conflict: true }]);
  expect(out.notes.get(S("a"))).toMatch(/sync trash/);
});

test("a first sync adds both sides together, removes nothing, and keeps each side's own same-named skill and server", () => {
  const out = run({
    fresh: true,
    // Bases from an older history count for nothing.
    bases: agreed({ skills: [skill("old")] }),
    local: items({
      skills: [skill("mine"), skill("same"), skill("clash", "# mine\n")],
      servers: [{ name: "fs", command: "npx" }],
      installed: [{ id: "x@m", enabled: false }],
    }),
    remote: itemsOf(
      profile({
        skills: [skill("theirs"), skill("same"), skill("clash", "# theirs\n")],
        servers: [{ name: "fs", command: "uvx" }],
        installed: [{ id: "x@m", enabled: true }],
      }),
    ),
  });
  expect(names(out.profile)).toEqual(["clash", "mine", "same", "theirs"]);
  // The clash stays as each has it: Cloud keeps its version, this Mac keeps its own, nothing is written.
  expect(out.profile.skills.find((s) => s.name === "clash")!.files[0]!.content).toBe("# theirs\n");
  expect(out.takes.map((t) => t.key)).toEqual([keyOf("install", "x@m"), S("theirs")]);
  expect(out.notes.get(S("clash"))).toMatch(/rename/);
  expect(out.notes.get(keyOf("server", "fs"))).toMatch(/each keeps its own/);
  expect(out.bases.get(keyOf("server", "fs"))).toMatchObject({ x: true });
  // A clash's bases record both sides, so nothing changes until one of them is edited.
  const again = run({
    bases: out.bases,
    local: items({
      skills: [skill("mine"), skill("same"), skill("clash", "# mine\n"), skill("theirs")],
      servers: [{ name: "fs", command: "npx" }],
      installed: [{ id: "x@m", enabled: true }],
    }),
    remote: itemsOf(out.profile),
  });
  expect(again.takes).toEqual([]);
  expect(again.profile).toEqual(out.profile);
});

test("a computer that only sends takes nothing, still sends its removals, and puts back what Cloud lost", () => {
  const was = { skills: [skill("kept"), skill("removed-here"), skill("lost-in-cloud")] };
  const out = run({
    apply: false,
    bases: agreed(was),
    local: items({ skills: [skill("kept"), skill("lost-in-cloud"), skill("new")] }),
    remote: itemsOf(
      profile({
        skills: [skill("kept", "# changed elsewhere\n"), skill("removed-here"), skill("elsewhere")],
      }),
    ),
  });
  expect(out.takes).toEqual([]);
  expect(names(out.profile)).toEqual(["elsewhere", "kept", "lost-in-cloud", "new"]);
  expect(out.profile.skills.find((s) => s.name === "kept")!.files[0]!.content).toBe(
    "# changed elsewhere\n",
  );
});

test("what cannot be written here, or cannot go from here, stays as each side has it and says why", () => {
  const was = { skills: [skill("linked"), skill("secret")] };
  const local = items({ skills: [skill("linked")] });
  local.set(
    S("secret"),
    heldItem("skill", "secret", "its SKILL.md looks like it holds a secret", undefined, "fp1"),
  );
  const out = run({
    bases: new Map([
      ...agreed(was),
      [S("secret"), { l: "held:fp0", r: itemsOf(profile(was)).get(S("secret"))!.digest }],
    ]),
    local,
    remote: itemsOf(profile({ skills: [skill("linked", "# new\n"), skill("secret")] })),
    blocked: (r) => (r?.id === "linked" ? "it links to ~/dev/linked" : undefined),
  });
  expect(out.takes).toEqual([]);
  expect(out.notes.get(S("linked"))).toBe("kept as it is here: it links to ~/dev/linked");
  expect(out.notes.get(S("secret"))).toMatch(/secret/);
  // Cloud keeps both as it has them; nothing here reads as removed.
  expect(names(out.profile)).toEqual(["linked", "secret"]);
  const again = run({
    bases: out.bases,
    local,
    remote: itemsOf(out.profile),
    blocked: (r) => (r?.id === "linked" ? "linked" : undefined),
  });
  expect(again.takes).toEqual([]);
  expect(again.profile).toEqual(out.profile);
});

test("a wiped skills folder on another computer never empties this one", () => {
  const many = Array.from({ length: MAX_SKILL_REMOVALS + 1 }, (_, i) => skill(`s${i}`));
  const out = run({
    bases: agreed({ skills: many }),
    local: items({ skills: many }),
    remote: itemsOf(profile({ skills: [] })),
  });
  expect(out.takes).toEqual([]);
  expect(out.notes.get(S("s0"))).toMatch(/removed on another of your computers at once/);
  // Held, not resent: Cloud stays without them and this Mac keeps them, until the person acts.
  expect(names(out.profile)).toEqual([]);
  const again = run({
    bases: out.bases,
    local: items({ skills: many }),
    remote: itemsOf(out.profile),
  });
  expect(again.takes).toEqual([]);
  expect(names(again.profile)).toEqual([]);
  // A few removals among many skills go through.
  const few = run({
    bases: agreed({ skills: many }),
    local: items({ skills: many }),
    remote: itemsOf(profile({ skills: many.slice(2) })),
  });
  expect(few.takes.map((t) => t.key)).toEqual([S("s0"), S("s1")]);
});

test("over Cloud's cap, this computer's newest additions wait and Cloud's stay", () => {
  const big = (name: string) => skill(name, "x".repeat(4000));
  const remote = itemsOf(profile({ skills: [big("theirs")] }));
  const out = run({
    fresh: true,
    local: items({ skills: [big("mine-a"), big("mine-b")] }),
    remote,
    maxBytes: 9000,
  });
  expect(names(out.profile)).toEqual(["mine-a", "theirs"]);
  expect(Buffer.byteLength(JSON.stringify(out.profile))).toBeLessThanOrEqual(9000);
  expect(out.notes.get(S("mine-b"))).toMatch(/2 MiB/);
  // Its base did not move: it goes once there is room.
  expect(out.bases.get(S("mine-b"))).toEqual({});
});

test("consent and the derived disabled list are never written here; Cloud's stays until this computer changes its own", () => {
  const remote = itemsOf(
    profile({ servers: [{ name: "fs", command: "npx", cloudConsent: true }] }),
  );
  const out = run({
    bases: agreed({ servers: [{ name: "fs", command: "npx" }] }),
    local: items({ servers: [{ name: "fs", command: "npx" }] }),
    remote,
  });
  expect(out.takes).toEqual([]);
  expect(out.profile.plugins.servers[0]).toMatchObject({ name: "fs", cloudConsent: true });
});

test("the same items assemble to the same bytes in any order; a Cursor import syncs as added by hand", () => {
  const a = itemsOf(
    profile({ skills: [skill("b"), skill("a")], installed: [{ id: "z@m" }, { id: "y@m" }] }),
  );
  const b = new Map([...a].reverse());
  expect(JSON.stringify(assemble(a, undefined))).toBe(JSON.stringify(assemble(b, undefined)));
  const cursor: Profile = {
    ...profile({}),
    plugins: {
      ...profile({}).plugins,
      servers: [{ name: "c", command: "npx", source: "cursor", enabled: true, cloud: "runs" }],
    },
  };
  const manual: Profile = {
    ...profile({}),
    plugins: {
      ...profile({}).plugins,
      servers: [{ name: "c", command: "npx", source: "manual", enabled: true, cloud: "runs" }],
    },
  };
  expect(itemsOf(cursor).get(keyOf("server", "c"))!.digest).toBe(
    itemsOf(manual).get(keyOf("server", "c"))!.digest,
  );
});

test("what Cloud sends is checked again before anything is written: paths that leave a skill, credentials in URLs", () => {
  expect(
    skillProblem({
      name: "x",
      files: [
        { path: "SKILL.md", content: "" },
        { path: "../../.zshrc", content: "" },
      ],
    }),
  ).toBeDefined();
  expect(
    skillProblem({
      name: "x",
      files: [
        { path: "SKILL.md", content: "" },
        { path: "/etc/passwd", content: "" },
      ],
    }),
  ).toBeDefined();
  expect(skillProblem({ name: "../x", files: [{ path: "SKILL.md", content: "" }] })).toBeDefined();
  expect(
    skillProblem({
      name: "x",
      files: [
        { path: "SKILL.md", content: "" },
        { path: "refs/./a", content: "" },
      ],
    }),
  ).toBeDefined();
  expect(
    skillProblem({
      name: "x",
      files: [
        { path: "SKILL.md", content: "" },
        { path: "refs/a.md", content: "" },
      ],
    }),
  ).toBeUndefined();
  const hostile = {
    version: 3,
    plugins: {
      spaces: [
        {
          url: "https://x-access-token:ghs_abc@github.com/a/b.git",
          commit: "a".repeat(40),
          enabled: true,
        },
      ],
      disabled: [],
      servers: [],
      installed: [],
      trustedHooks: [],
    },
    skills: [
      {
        name: "evil",
        source: "claude-home",
        files: [
          { path: "SKILL.md", content: "" },
          { path: "../evil", content: "" },
        ],
      },
    ],
  } as unknown as Profile;
  expect([...itemsOf(hostile).keys()]).toEqual([]);
  const ok: SyncItem | undefined = itemsOf(profile({ skills: [skill("fine")] })).get(S("fine"));
  expect(ok?.kind).toBe("skill");
});

test("same-named skills and servers kept apart at a first sync stay apart: neither side's later edit replaces the other's", () => {
  const first = run({
    fresh: true,
    local: items({
      skills: [skill("clash", "# mine\n")],
      servers: [{ name: "fs", command: "npx" }],
    }),
    remote: itemsOf(
      profile({
        skills: [skill("clash", "# theirs\n")],
        servers: [{ name: "fs", command: "uvx" }],
      }),
    ),
  });
  expect(first.bases.get(S("clash"))).toMatchObject({ x: true });
  // The other computer edits its own: nothing is written here, and Cloud keeps the other computer's edit.
  const theirsEdited = itemsOf(
    profile({
      skills: [skill("clash", "# theirs, edited\n")],
      servers: [{ name: "fs", command: "uvx" }],
    }),
  );
  const after = run({
    bases: first.bases,
    local: items({
      skills: [skill("clash", "# mine\n")],
      servers: [{ name: "fs", command: "npx" }],
    }),
    remote: theirsEdited,
  });
  expect(after.takes).toEqual([]);
  expect(after.profile.skills[0]!.files[0]!.content).toBe("# theirs, edited\n");
  // This Mac edits its own: it does not go over the other computer's either.
  const mineEdited = run({
    bases: after.bases,
    local: items({
      skills: [skill("clash", "# mine, edited\n")],
      servers: [{ name: "fs", command: "npx" }],
    }),
    remote: itemsOf(after.profile),
  });
  expect(mineEdited.takes).toEqual([]);
  expect(mineEdited.profile.skills[0]!.files[0]!.content).toBe("# theirs, edited\n");
  // Once both hold the same, they move together again.
  const same = run({
    bases: mineEdited.bases,
    local: items({
      skills: [skill("clash", "# theirs, edited\n")],
      servers: [{ name: "fs", command: "uvx" }],
    }),
    remote: itemsOf(mineEdited.profile),
  });
  expect(same.bases.get(S("clash"))?.x).toBeUndefined();
  const together = run({
    bases: same.bases,
    local: items({
      skills: [skill("clash", "# theirs, edited\n")],
      servers: [{ name: "fs", command: "uvx" }],
    }),
    remote: itemsOf(
      profile({
        skills: [skill("clash", "# shared now\n")],
        servers: [{ name: "fs", command: "uvx" }],
      }),
    ),
  });
  expect(together.takes.map((t) => t.key)).toEqual([S("clash")]);
});

test("a skill file path into .git or node_modules from Cloud is refused", () => {
  expect(
    skillProblem({
      name: "x",
      files: [
        { path: "SKILL.md", content: "" },
        { path: ".git/config", content: "[core]\n\tfsmonitor = rm -rf ~\n" },
      ],
    }),
  ).toBeDefined();
  expect(
    skillProblem({
      name: "x",
      files: [
        { path: "SKILL.md", content: "" },
        { path: "node_modules/.bin/x", content: "" },
      ],
    }),
  ).toBeDefined();
});
