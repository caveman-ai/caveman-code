import { describe, expect, it } from "vitest";

import { ComputerCredits, type ComputerCreditsCloud, type MintedCredits } from "./computerCredits.ts";
import { HOSTED_CLOUD } from "./hosted.ts";
import { CloudError } from "./identity.ts";

const HOUR = 60 * 60_000;

/** A Cloud whose credits route answers what the test says, on a clock the test turns. */
function world(cloudUrl = "https://cloud.customer.example") {
  let now = Date.parse("2026-11-07T10:00:00Z");
  let n = 0;
  const asked: Array<number> = [];
  const remembered: Array<string> = [];
  let answer: () => Promise<MintedCredits> = async () => {
    n++;
    return { id: `key-${n}`, key: `cave_live_computer_${n}`, expires_at: new Date(now + HOUR).toISOString(), gateway_url: "https://gateway.customer.example" };
  };
  const cloud: ComputerCreditsCloud = {
    mint: () => {
      asked.push(now);
      return answer();
    },
    cloudUrl: () => cloudUrl,
    remember: (key) => void remembered.push(key),
  };
  const credits = new ComputerCredits({ now: () => now });
  return {
    credits,
    cloud,
    asked,
    remembered,
    later: (ms: number) => void (now += ms),
    answers: (next: () => Promise<MintedCredits>) => void (answer = next),
    mintOk: () =>
      (answer = async () => {
        n++;
        return { id: `key-${n}`, key: `cave_live_computer_${n}`, expires_at: new Date(now + HOUR).toISOString(), gateway_url: "https://gateway.customer.example" };
      }),
  };
}

describe("a Cloud computer's Caveman credits key", () => {
  it("made for the runtime the computer stopped under is not handed out after a wake under a new identity, though the same process resumed holding it", async () => {
    const w = world();
    let runtime = "runtime-before";
    w.credits.connect({ ...w.cloud, runtime: () => runtime });
    expect(await w.credits.get()).toEqual({ key: "cave_live_computer_1", gateway: "https://gateway.customer.example" });
    // Minutes later, well inside the key's hour, nothing is asked again while the computer is the same runtime.
    w.later(5 * 60_000);
    expect((await w.credits.get())?.key).toBe("cave_live_computer_1");
    expect(w.asked).toHaveLength(1);
    // The VM's memory was kept across a stop: this process resumes, and Cloud gave the computer a new identity.
    runtime = "runtime-after";
    expect(w.credits.peek()).toBeUndefined();
    expect(w.credits.available()).toBe(true);
    // The next request asks for a key of the runtime it is now; the old one is never sent again.
    expect((await w.credits.get())?.key).toBe("cave_live_computer_2");
    expect(w.asked).toHaveLength(2);
    expect(w.credits.peek()?.key).toBe("cave_live_computer_2");
  });

  it("is none off a Cloud computer: nothing is asked of Cloud", async () => {
    const w = world();
    expect(w.credits.available()).toBe(false);
    expect(w.credits.peek()).toBeUndefined();
    expect(await w.credits.get()).toBeUndefined();
    expect(w.asked).toHaveLength(0);
  });

  it("is never asked for to say whether credits run here, or what is held: only a request that needs it asks", async () => {
    const w = world();
    w.credits.connect(w.cloud);
    expect(w.credits.available()).toBe(true);
    expect(w.credits.peek()).toBeUndefined();
    expect(w.asked).toHaveLength(0);
    await w.credits.get();
    expect(w.credits.peek()).toEqual({ key: "cave_live_computer_1", gateway: "https://gateway.customer.example" });
    expect(w.asked).toHaveLength(1);
  });

  it("is asked of Cloud once however many reads wait for it, joins the scrubber, and runs on the gateway its Cloud named", async () => {
    const w = world();
    w.credits.connect(w.cloud);
    const all = await Promise.all([w.credits.get(), w.credits.get(), w.credits.get()]);
    expect(all).toEqual([0, 1, 2].map(() => ({ key: "cave_live_computer_1", gateway: "https://gateway.customer.example" })));
    expect(w.asked).toHaveLength(1);
    expect(w.remembered).toEqual(["cave_live_computer_1"]);
  });

  it("runs on Caveman's own gateway for the hosted Cloud, whatever it names, and on none for a Cloud that names none", async () => {
    const hosted = world(HOSTED_CLOUD);
    hosted.credits.connect(hosted.cloud);
    expect(await hosted.credits.get()).toEqual({ key: "cave_live_computer_1" });
    const silent = world();
    silent.answers(async () => ({ id: "k", key: "cave_live_computer_x", expires_at: new Date(Date.now() + HOUR).toISOString() }));
    silent.credits.connect(silent.cloud);
    expect(await silent.credits.get()).toBeUndefined();
  });

  it("is renewed in the background once half its life is gone: the key held is handed over at once, the new one after", async () => {
    const w = world();
    w.credits.connect(w.cloud);
    await w.credits.get();
    w.later(29 * 60_000);
    expect((await w.credits.get())?.key).toBe("cave_live_computer_1");
    expect(w.asked).toHaveLength(1);
    w.later(2 * 60_000);
    let answer!: (minted: MintedCredits) => void;
    w.answers(() => new Promise((resolve) => (answer = resolve)));
    // Cloud has not answered: the request goes on with the key held, never waiting.
    expect((await w.credits.get())?.key).toBe("cave_live_computer_1");
    expect((await w.credits.get())?.key).toBe("cave_live_computer_1");
    expect(w.asked).toHaveLength(2);
    answer({ id: "key-2", key: "cave_live_computer_2", expires_at: new Date(Date.parse("2026-11-07T11:31:00Z") + HOUR).toISOString(), gateway_url: "https://gateway.customer.example" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect((await w.credits.get())?.key).toBe("cave_live_computer_2");
    expect(w.remembered).toEqual(["cave_live_computer_1", "cave_live_computer_2"]);
  });

  it("keeps a key that still runs while Cloud is unreachable, asks again less and less often, and holds none once it has expired", async () => {
    const w = world();
    w.credits.connect(w.cloud);
    await w.credits.get();
    w.answers(async () => {
      throw new TypeError("fetch failed");
    });
    w.later(31 * 60_000);
    const asks = () => w.asked.length - 1;
    expect((await w.credits.get())?.key).toBe("cave_live_computer_1");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(asks()).toBe(1);
    // 3 s, then 6 s, then 12 s: never a loop.
    for (const wait of [3_000, 6_000, 12_000]) {
      w.later(wait - 1);
      await w.credits.get();
      await new Promise((resolve) => setTimeout(resolve, 0));
      const before = asks();
      w.later(1);
      await w.credits.get();
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(asks()).toBe(before + 1);
    }
    w.later(30 * 60_000);
    expect(await w.credits.get()).toBeUndefined();
  });

  it("waits as long as Cloud's Retry-After says when it is busy", async () => {
    const w = world();
    w.credits.connect(w.cloud);
    w.answers(async () => {
      throw new CloudError(429, "Too many requests.", "cave_auth_rate_limited", 20_000);
    });
    expect(await w.credits.get()).toBeUndefined();
    w.later(19_000);
    expect(await w.credits.get()).toBeUndefined();
    expect(w.asked).toHaveLength(1);
    w.later(1_000);
    w.mintOk();
    expect((await w.credits.get())?.key).toBe("cave_live_computer_1");
  });

  it("keeps the key it holds through a refusal that passes (a project's policy still on its way)", async () => {
    const w = world();
    w.credits.connect(w.cloud);
    await w.credits.get();
    w.later(31 * 60_000);
    w.answers(async () => {
      throw new CloudError(409, "Ask again once the project's initial policy is delivered.", "cave_policy_delivery_pending");
    });
    expect((await w.credits.get())?.key).toBe("cave_live_computer_1");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(w.credits.peek()?.key).toBe("cave_live_computer_1");
    expect(w.credits.available()).toBe(true);
  });

  it("drops its key when Cloud says the computer is idle, and asks again soon: the computer may get its chat any moment", async () => {
    const w = world();
    w.credits.connect(w.cloud);
    await w.credits.get();
    w.later(31 * 60_000);
    w.answers(async () => {
      throw new CloudError(403, "This computer runs no workspace, so it acts for no one.", "cave_code_computer_idle");
    });
    await w.credits.get();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(w.credits.peek()).toBeUndefined();
    expect(await w.credits.get()).toBeUndefined();
    expect(w.asked).toHaveLength(2);
    w.later(3_000);
    w.mintOk();
    expect((await w.credits.get())?.key).toBe("cave_live_computer_2");
  });

  it("goes quiet for long, holding nothing and offering no credits, where Cloud says this computer is not to spend them", async () => {
    for (const [status, code] of [
      [403, "cave_code_credits_computer_only"],
      [403, "cave_code_service_account_session"],
      [403, "cave_code_computer_shared"],
      [403, "cave_forbidden"],
      [403, "cave_code_credits_forbidden"],
      [409, "cave_code_credits_no_project"],
      [404, "cave_code_credits_unavailable"],
      [401, "cave_unauthorized"],
    ] as const) {
      const w = world();
      w.credits.connect(w.cloud);
      await w.credits.get();
      w.later(31 * 60_000);
      w.answers(async () => {
        throw new CloudError(status, "No.", code);
      });
      await w.credits.get();
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(w.credits.peek(), code).toBeUndefined();
      expect(w.credits.available(), code).toBe(false);
      w.later(14 * 60_000);
      expect(await w.credits.get(), code).toBeUndefined();
      expect(w.asked, code).toHaveLength(2);
      w.later(60_000);
      w.mintOk();
      expect((await w.credits.get())?.key, code).toBe("cave_live_computer_2");
      expect(w.credits.available(), code).toBe(true);
    }
  });

  it("asks no more for a minute after an answer that is no key: never a loop that mints for nothing", async () => {
    const w = world();
    w.credits.connect(w.cloud);
    w.answers(async () => ({ id: "k", key: "not-a-key", expires_at: "soon" }));
    expect(await w.credits.get()).toBeUndefined();
    w.later(59_000);
    expect(await w.credits.get()).toBeUndefined();
    expect(w.asked).toHaveLength(1);
    w.later(1_000);
    w.mintOk();
    expect((await w.credits.get())?.key).toBe("cave_live_computer_1");
  });

  it("goes quiet for long where its Cloud names no gateway this computer may use: each ask there mints a key for nothing", async () => {
    const w = world("https://cloud.customer.example");
    w.answers(async () => ({ id: "k", key: "cave_live_computer_x", expires_at: new Date(Date.parse("2026-11-07T11:00:00Z")).toISOString(), gateway_url: "https://gateway.caveman.so" }));
    w.credits.connect(w.cloud);
    expect(await w.credits.get()).toBeUndefined();
    expect(w.credits.available()).toBe(false);
    w.later(14 * 60_000);
    expect(await w.credits.get()).toBeUndefined();
    expect(w.asked).toHaveLength(1);
    w.later(60_000);
    w.mintOk();
    expect(await w.credits.get()).toEqual({ key: "cave_live_computer_1", gateway: "https://gateway.customer.example" });
  });

  it("forgets everything when the computer's link goes", async () => {
    const w = world();
    w.credits.connect(w.cloud);
    await w.credits.get();
    w.credits.disconnect();
    expect(await w.credits.get()).toBeUndefined();
    expect(w.credits.peek()).toBeUndefined();
    expect(w.credits.available()).toBe(false);
  });
});
