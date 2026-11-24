import { createScrubber } from "@caveman-app/session-protocol";
import { expect, test } from "vitest";

import { chainScrubbers } from "../secrets/EgressScrub.ts";

const project = "Ab3dEf9h-ProjectTailZ9";
const encoded = Buffer.from(project).toString("base64");

test.each([
  { name: "raw", prefix: `runtime-${project.slice(0, 8)}`, suffix: project.slice(8) },
  { name: "same start", prefix: project.slice(0, 8), suffix: project.slice(8) },
  { name: "base64", prefix: `runtime-${encoded.slice(0, 12)}`, suffix: encoded.slice(12) },
  {
    name: "wrapped base64",
    prefix: `runtime-${encoded.slice(0, 4)}\r\n${encoded.slice(4, 12)}`,
    suffix: encoded.slice(12),
  },
])(
  "$name: an overlapping runtime credential cannot consume a project secret's prefix",
  ({ prefix, suffix }) => {
    const stream = chainScrubbers(
      createScrubber([{ name: "PROJECT", value: project }]),
      createScrubber([{ name: "RUNTIME", value: prefix }]),
    ).stream();
    const out = stream.push(prefix) + stream.push(suffix) + stream.flush();
    expect(out).toContain("[secret:PROJECT]");
    for (let at = 0; at + 8 <= suffix.length; at++)
      expect(out).not.toContain(suffix.slice(at, at + 8));
  },
);
