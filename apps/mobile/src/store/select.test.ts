// An ask's short question (select.ts shortAsk), the title of its card and its line in every row: a bare command is
// never its own title, since the command chip under it prints the command once. Words that say what the command is for
// stay, and so does a question, which is not a command.
import { describe, expect, it, vi } from "vitest";

vi.mock("./persist", () => ({
  KEYS: { board: "board", inbox: "inbox", sessions: "sessions", boot: "boot" },
  read: () => null,
  write: () => {},
  flush: () => {},
  remove: () => {},
  clearPersisted: () => {},
  onLeave: () => () => {},
  FRESH: false,
}));

import { shortAsk, SHORT_ASK } from "./select";

describe("an approval's short question", () => {
  it("is the plain question when the chat's words are only its command", () => {
    // A real computer's chat: its line is the command it waits to run.
    expect(shortAsk({ line: "echo smoke", ask: "echo smoke" }).ask).toBe("Run this command?");
    expect(shortAsk({ line: "", ask: "echo smoke" }).ask).toBe("Run this command?");
    expect(shortAsk({ line: "wants to run echo smoke" }, "echo smoke").ask).toBe(
      "Run this command?",
    );
  });
  it("is the same plain question however long the bare command is", () => {
    const long = "node scripts/reindex.js --from 2026-01-01 --to 2026-11-01 --batch 500";
    expect(long.length).toBeGreaterThan(SHORT_ASK);
    expect(shortAsk({ line: long, ask: long }).ask).toBe("Run this command?");
  });
  it("never holds the command", () => {
    for (const command of ["echo smoke", "ls -la build", "node scripts/reindex.js --batch 500"]) {
      expect(shortAsk({ line: command, ask: command }).ask).not.toContain(command);
    }
  });
  it("keeps words that say what the command is for", () => {
    expect(
      shortAsk({ line: "wants to rebuild the index", ask: "node scripts/reindex.js" }).ask,
    ).toBe("Rebuild the index?");
  });
  it("keeps the kinds it already names from the command", () => {
    expect(shortAsk({ line: "pnpm add zod", ask: "pnpm add zod" })).toEqual({
      ask: "Add a package?",
      object: "zod",
    });
    expect(
      shortAsk({ line: "pnpm db:migrate --env staging", ask: "pnpm db:migrate --env staging" }).ask,
    ).toBe("Run a staging migration?");
    expect(shortAsk({ line: "pnpm test relay", ask: "pnpm test relay" }).ask).toBe(
      "Run the tests?",
    );
  });
});

describe("a question's short form", () => {
  it("is its own text, which is not a command", () => {
    expect(shortAsk({ line: "Keep the legacy flag?" }).ask).toBe("Keep the legacy flag?");
  });
});
