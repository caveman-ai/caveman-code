import { describe, expect, it } from "vitest";
import { accessLine, holdingWhat } from "./OnCloud.tsx";
import { thisComputer } from "../../lib/platform.ts";

describe("access log in plain words", () => {
  it("names who read what", () => {
    expect(accessLine({ at: "", action: "code.secret.resolve", names: ["DATABASE_URL"], workspace_title: "Fix login" })).toBe("Fix login in Cloud read DATABASE_URL");
    expect(accessLine({ at: "", action: "code.connection.lease", names: ["linear"], computer_id: "0190f5c4-8a3e" })).toBe("Cloud used the sign-in for linear");
    expect(accessLine({ at: "", action: "code.profile.get", names: [], computer_id: "c1" })).toBe("Cloud loaded your settings");
    expect(accessLine({ at: "", action: "code.connection.reconnect_needed", names: ["notion"] })).toBe("The sign-in for notion stopped working");
    expect(accessLine({ at: "", action: "code.connection.delete", names: [], actor_type: "user" })).toBe("You deleted");
  });
});

describe("what Cloud holds, in a line", () => {
  it("tells Cloud's GitHub login from a sign-in made here, and repository secrets from wherever they were set", () => {
    expect(holdingWhat({ kind: "connection", id: "github" })).toBe("Your GitHub login, connected through Caveman. Removing it deletes the GitHub login Caveman keeps for you.");
    expect(holdingWhat({ kind: "connection", id: "0190f5c4" })).toBe("Tokens from a sign-in you made with Caveman.");
    expect(holdingWhat({ kind: "repository_secrets", id: "github.com/acme/widgets" })).toBe(`Encrypted values for this repository, set from ${thisComputer}, another computer or Caveman Platform.`);
  });
});
