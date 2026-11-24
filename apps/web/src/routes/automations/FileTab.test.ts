import { describe, expect, it } from "vitest";
import { savedBuffers } from "./FileTab.tsx";
import { SCHEMA_LINE } from "./model.ts";

// The File tab's open files after ⌘S's write answers. The editor stays editable during the write.
describe("the File tab after a save", () => {
  const path = ".caveman/automations/nightly.yaml";
  const onDisk = `${SCHEMA_LINE}\nname: nightly\n`;
  const sent = `${onDisk}schedule: daily\n`;

  it("keeps what was typed while the write was in flight, still unsaved", () => {
    const typed = `${sent}timezone: Europe/Amsterdam\n`;
    const after = savedBuffers({ [path]: { saved: onDisk, text: typed } }, path, sent, sent);
    expect(after[path]).toEqual({ saved: sent, text: typed });
  });

  it("is clean when nothing was typed meanwhile, and shows the file as written, its schema line too", () => {
    const bare = "name: nightly\n";
    const after = savedBuffers(
      { [path]: { saved: "", text: bare } },
      path,
      bare,
      `${SCHEMA_LINE}\n${bare}`,
    );
    expect(after[path]).toEqual({
      saved: `${SCHEMA_LINE}\n${bare}`,
      text: `${SCHEMA_LINE}\n${bare}`,
    });
  });

  it("leaves the other open files as they are", () => {
    const agent = { saved: "a\n", text: "a\nb\n" };
    expect(
      savedBuffers(
        { [path]: { saved: onDisk, text: sent }, "agents/x.md": agent },
        path,
        sent,
        sent,
      )["agents/x.md"],
    ).toBe(agent);
  });
});
