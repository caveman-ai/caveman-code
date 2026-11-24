// ADEMark Track A (speed and weight, TESTS.md §2) on the packaged app, against ADEMark's replay server. Weight uses
// ADEMark's own sampler, so A5, A6, A7 and A10 are its numbers. Speed is read from the page over CDP instead of
// ADEMark's pixels (its echo timer needs Screen Recording and Accessibility granted to its helper): the probe is
// typed as keys and Ready is the first frame after the composer holds it, so a value here is a little under ADEMark's,
// which also waits for the compositor and its 50 ms probe cadence (about one frame to 67 ms, TESTS.md §1.3).
import * as fs from "node:fs";
import * as path from "node:path";

import {
  chat,
  launchApp,
  log,
  mb,
  now,
  processTree,
  sample,
  sleep,
  startRuntime,
  until,
  type LaunchedApp,
  type Profile,
  type ReplayRequest,
  type SampleSummary,
} from "./harness.ts";

type Page = import("playwright-core").Page;

const COMPOSER = '[data-composer] textarea[aria-label="Message"]';
const SEED = "replay:seed";

/**
 * ADEMark's seeded state: the arena as a project with 5 finished chats (`replay:seed`), the first run behind it, the
 * window on one of those chats. Made through the app's own runtime, never by writing its storage.
 */
export async function seed(
  app: string,
  profile: Profile,
  env: NodeJS.ProcessEnv,
  threads = 5,
): Promise<Array<string>> {
  const runtime = await startRuntime(app, env);
  const ids: Array<string> = [];
  try {
    for (let i = 1; i <= threads; i++)
      ids.push((await chat(runtime, profile.arena, SEED, `seed-${i}`)).workspaceId);
  } finally {
    await runtime.stop();
  }
  const launched = launchApp(app, profile, env);
  try {
    const page = await launched.page();
    await page.evaluate(() => localStorage.setItem("caveman.firstRunDone", "1"));
    await page.evaluate((id) => (location.hash = `#/w/${id}`), ids[0]!);
    await until(
      "a seeded chat's composer",
      () => page.locator(COMPOSER).first().isVisible(),
      60_000,
    );
    await sleep(2_000);
  } finally {
    await launched.quit();
  }
  return ids;
}

/**
 * More chats made the way the seed made its five (ADEMark A10 adds 15 `replay:seed` chats; A11 makes one
 * `replay:long-2000`, 1,000 steps of text and a Read, about 2,000 visible items). The app must be closed: one runtime
 * runs per home.
 */
export async function addChats(
  app: string,
  profile: Profile,
  env: NodeJS.ProcessEnv,
  prompt: string,
  count: number,
  timeoutMs?: number,
): Promise<Array<string>> {
  const runtime = await startRuntime(app, env);
  const ids: Array<string> = [];
  try {
    for (let i = 1; i <= count; i++)
      ids.push(
        (
          await chat(
            runtime,
            profile.arena,
            prompt,
            `${prompt.replace(/\W+/g, "-")}-${Date.now()}-${i}`,
            timeoutMs,
          )
        ).workspaceId,
      );
  } finally {
    await runtime.stop();
  }
  return ids;
}

/**
 * A11 Open: from a short chat, open the long one; the value is the time until its last message (`LONGTHREAD-END`) is
 * in view and the page has not changed for 1 s (ADEMark's visually settled), minus that second.
 */
export async function longThreadOpen(
  page: Page,
  shortId: string,
  longId: string,
  runs: number,
): Promise<Array<number>> {
  const values: Array<number> = [];
  for (let i = 0; i < runs; i++) {
    await openSeeded(page, shortId);
    await sleep(1_000);
    // The switch and the clock both start inside the page, so the value is the page's own time to settle.
    const settled = await page.evaluate(
      ({ id, deadline }) =>
        new Promise<number>((resolve, reject) => {
          const started = performance.now();
          let last = started;
          let seen = 0;
          const observer = new MutationObserver(() => (last = performance.now()));
          observer.observe(document.body, {
            subtree: true,
            childList: true,
            characterData: true,
            attributes: true,
          });
          location.hash = `#/w/${id}`;
          const tick = () => {
            const end = [...document.querySelectorAll("p, div, span")].find(
              (el) => el.childElementCount === 0 && el.textContent?.includes("LONGTHREAD-END"),
            );
            const rect = end?.getBoundingClientRect();
            const inView =
              rect !== undefined && rect.height > 0 && rect.bottom > 0 && rect.top < innerHeight;
            if (inView) seen ||= performance.now();
            if (inView && performance.now() - last >= 1_000) {
              observer.disconnect();
              return resolve(Math.max(last, seen) - started);
            }
            if (performance.now() - started > deadline) {
              observer.disconnect();
              return reject(
                new Error(
                  inView ? "the long chat never settled" : "LONGTHREAD-END never came into view",
                ),
              );
            }
            requestAnimationFrame(tick);
          };
          requestAnimationFrame(tick);
        }),
      { id: longId, deadline: 30_000 },
    );
    values.push(settled);
    log(`long thread open ${i + 1}/${runs}: ${values.at(-1)!.toFixed(0)} ms`);
  }
  return values;
}

/**
 * Ready (TESTS.md §1.3): the composer takes a probe. Focus is given the way ADEMark's click would if the app did not
 * focus it; then two probe keys, and Ready is the next frame once the composer holds them. The probe is cleared.
 */
async function ready(page: Page, t0: number, deadlineMs = 60_000): Promise<number> {
  const end = Date.now() + deadlineMs;
  for (;;) {
    const state = await page
      .evaluate((selector) => {
        const box = [...document.querySelectorAll<HTMLTextAreaElement>(selector)].find(
          (t) => t.getClientRects().length > 0 && !t.disabled && !t.readOnly,
        );
        if (!box) return "none";
        if (document.activeElement !== box) box.focus();
        return "ok";
      }, COMPOSER)
      .catch(() => "none");
    if (state === "ok") {
      await page.keyboard.type("ad");
      const echoed = await page
        .waitForFunction(
          (selector) => {
            const box = [...document.querySelectorAll<HTMLTextAreaElement>(selector)].find(
              (t) => t.getClientRects().length > 0,
            );
            return box !== undefined && box.value.includes("ad")
              ? new Promise<boolean>((r) => requestAnimationFrame(() => r(true)))
              : false;
          },
          COMPOSER,
          { timeout: 2_000, polling: "raf" },
        )
        .then(
          () => true,
          () => false,
        );
      if (echoed) {
        const at = now() - t0;
        await page.keyboard.press("Meta+A");
        await page.keyboard.press("Backspace");
        return at;
      }
    }
    if (Date.now() > end) throw new Error("the composer never took the probe");
    await sleep(10);
  }
}

/** A1/A2: launch to typing accepted. ADEMark's cold tier also purges the file cache (sudo); here every run is a process-cold launch. */
export async function launchToTyping(
  app: string,
  profile: Profile,
  env: NodeJS.ProcessEnv,
  runs: number,
): Promise<Array<number>> {
  const values: Array<number> = [];
  for (let i = 0; i < runs; i++) {
    const launched = launchApp(app, profile, env);
    try {
      const page = await launched.page();
      // ADEMark reads the probe off the window's pixels: a hidden window cannot be ready.
      await until(
        "the window on screen",
        () => page.evaluate(() => document.visibilityState === "visible"),
        60_000,
        5,
      );
      values.push(await ready(page, launched.t0));
      log(`launch ${i + 1}/${runs}: ${values.at(-1)!.toFixed(0)} ms`);
    } finally {
      await launched.quit();
    }
    // ADEMark waits for the Mac to be quiet; the runtime's children need a moment to go.
    await sleep(3_000);
  }
  return values;
}

const NEW_CHAT = "[data-tour=new-chat]";

/** Opens a seeded chat, as A3 starts from one (its `shortThread` step). */
async function openSeeded(page: Page, workspaceId: string) {
  // Asked again while the app sends it elsewhere: a chat it does not know yet (its runtime still starting) opens New chat.
  await until(
    "the seeded chat",
    async () => {
      if (!page.url().includes(`#/w/${workspaceId}`))
        await page.evaluate((id) => (location.hash = `#/w/${id}`), workspaceId);
      return page.getByText("the repository is unchanged").first().isVisible();
    },
    30_000,
  );
}

/** A3: the New chat action (a click on New chat, the app's default mode) to typing accepted in the new composer. */
export async function threadOpen(page: Page, seeded: string, runs: number): Promise<Array<number>> {
  const values: Array<number> = [];
  for (let i = 0; i < runs; i++) {
    await openSeeded(page, seeded);
    const t0 = now();
    await page.locator(NEW_CHAT).click();
    await until("the new chat", () => page.url().includes("#/new"), 30_000, 2);
    values.push(await ready(page, t0));
    log(`thread open ${i + 1}/${runs}: ${values.at(-1)!.toFixed(0)} ms`);
  }
  return values;
}

/** Types `text` into the visible composer and sends it with Enter; returns when Enter was posted (A4's t0). */
async function send(page: Page, text: string): Promise<number> {
  // The visible composer, focused as ready() focuses it: a route change can leave a hidden one in the page, and just
  // after New chat the chat before stays on screen a moment (PaneFrame's hold), so the text is checked where it shows.
  await until(
    "the text in the visible composer",
    async () => {
      const focused = await page.evaluate((selector) => {
        const box = [...document.querySelectorAll<HTMLTextAreaElement>(selector)].find(
          (t) => t.getClientRects().length > 0 && !t.disabled,
        );
        box?.focus();
        return box !== undefined && document.activeElement === box ? box.value : null;
      }, COMPOSER);
      if (focused === null) return false;
      // A try that went in only in part: empty the box first.
      if (focused !== "") {
        await page.keyboard.press("Meta+A");
        await page.keyboard.press("Backspace");
      }
      await page.keyboard.insertText(text);
      await sleep(500);
      return page.evaluate(
        ({ selector, text }) => {
          const box = [...document.querySelectorAll<HTMLTextAreaElement>(selector)].find(
            (t) => t.getClientRects().length > 0 && !t.disabled,
          );
          return box !== undefined && document.activeElement === box && box.value === text;
        },
        { selector: COMPOSER, text },
      );
    },
    30_000,
  );
  const t0 = now();
  await page.keyboard.press("Enter");
  return t0;
}

/** One A4 run: the value (Enter to the first word on screen) and where it went, read off the replay server's log. */
export interface FirstWordRun {
  /** Enter to `LEDGERMARK` on screen: A4's value. */
  readonly total: number;
  /** Enter to the answer's model request reaching the replay server (the app built it and its `claude` sent it). */
  readonly request?: number;
  /** That request to the first word on screen (the stream back through the CLI, runtime and page). */
  readonly render?: number;
  /** Model requests the replay server took between Enter and the first word (the answer's and any others). */
  readonly requests?: number;
}

/**
 * A4: Enter to the first word of the answer (`LEDGERMARK`, ADEMark's `replay:hi`) on screen, each run in a new chat.
 * With the replay server's log (`requests`) each run is split at its model request.
 */
export async function firstWord(
  page: Page,
  seeded: string,
  runs: number,
  requests?: () => ReadonlyArray<ReplayRequest>,
): Promise<Array<FirstWordRun>> {
  const values: Array<FirstWordRun> = [];
  // ADEMark re-runs an invalid repetition up to 3 extra times (TESTS.md A4 Validity).
  for (let i = 0, failed = 0; values.length < runs; i++) {
    await openSeeded(page, seeded);
    await page.locator(NEW_CHAT).click();
    await until("the new chat", () => page.url().includes("#/new"), 30_000, 2);
    await ready(page, now());
    const t0 = await send(page, "replay:hi");
    const shown = await page
      .waitForFunction(
        () =>
          document.body.innerText.includes("LEDGERMARK") &&
          new Promise<boolean>((r) => requestAnimationFrame(() => r(true))),
        undefined,
        { timeout: 30_000, polling: "raf" },
      )
      .then(
        () => true,
        () => false,
      );
    if (!shown) {
      log(
        `first word ${i + 1}: no LEDGERMARK within 30 s, invalid${++failed > 3 ? "; giving up" : ", run again"}`,
      );
      if (failed > 3) throw new Error("A4: four runs never showed the first word");
      continue;
    }
    const t1 = now();
    const run: { -readonly [K in keyof FirstWordRun]: FirstWordRun[K] } = { total: t1 - t0 };
    if (requests) {
      const taken = requests().filter((r) => r.t >= t0 && r.t <= t1);
      run.requests = taken.length;
      const answer = taken.find((r) => r.session === "hi");
      if (answer) {
        run.request = answer.t - t0;
        run.render = t1 - answer.t;
      }
    }
    values.push(run);
    const split =
      run.request === undefined
        ? ""
        : ` (request ${run.request.toFixed(0)} ms, then ${run.render!.toFixed(0)} ms to the screen; ${run.requests} model requests)`;
    log(`first word ${values.length}/${runs}: ${run.total.toFixed(0)} ms${split}`);
    await sleep(1_500);
  }
  return values;
}

/**
 * A7: five new chats each streaming ADEMark's 3-minute `replay:stream-<n>`, started 2 s apart, sampled for the whole
 * window with chat 1 in front. Returns the sample; the caller reads app, agents and total p95.
 */
export async function fightWeight(
  launched: LaunchedApp,
  helper: string,
  dir: string,
  seconds = 150,
): Promise<SampleSummary> {
  const page = await launched.page();
  let first: string | undefined;
  for (let n = 1; n <= 5; n++) {
    await page.locator(NEW_CHAT).click();
    await until("the new chat", () => page.url().includes("#/new"), 30_000, 2);
    await ready(page, now());
    await send(page, `replay:stream-${n}`);
    await until("the chat to start", () => /#\/w\//.test(page.url()), 30_000);
    first ??= page.url();
    await sleep(2_000);
  }
  await page.evaluate((url) => (location.href = url), first!);
  return sample(helper, launched.pid, seconds, dir);
}

/** A5 and A6: the app at rest with its seeded chats, after it settles; then ADEMark's 60 s window. */
export async function weighIn(
  launched: LaunchedApp,
  helper: string,
  dir: string,
  settleMs = 30_000,
): Promise<SampleSummary> {
  await launched.page();
  await sleep(settleMs);
  return sample(helper, launched.pid, 60, dir);
}

/** A9: what still runs from the app 60 s after a normal quit (here: any process left from its tree). */
export async function ghostWeight(launched: LaunchedApp): Promise<Array<string>> {
  const tree = processTree(launched.pid).map((p) => p.pid);
  await launched.quit();
  await sleep(60_000);
  const alive = new Set(processTree(1).map((p) => p.pid));
  return tree.filter((pid) => alive.has(pid)).map(String);
}

export function median(values: ReadonlyArray<number>): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

export const summarizeWeight = (s: SampleSummary) => ({
  app_mb: Math.round(mb(s.app_median_b)),
  agents_mb: Math.round(mb(s.agents_median_b)),
  total_mb: Math.round(mb(s.total_median_b)),
  agent_count: s.agent_count,
  cpu_percent: Number(s.app_cpu_percent.toFixed(3)),
  wakeups_per_s: Number(s.app_wakeups_per_s.toFixed(1)),
  top: s.top,
});

export function writeJson(file: string, value: unknown) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}
