// src/main.ts when its runtime's entry file is missing (a damaged install), under the stand-in Electron in
// test/fakeElectron.ts with the real RuntimeSupervisor. Its own file: main.ts starts once per process.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, expect, it, vi } from "vitest";
import type { RuntimeSupervisor } from "../src/runtime.ts";

const started = vi.hoisted(() => [] as RuntimeSupervisor[]);
vi.mock("electron", async () => {
  const { electron } = await import("./fakeElectron.ts");
  return { ...electron, default: electron };
});
vi.mock("electron-updater", async () => {
  const { EventEmitter } = await import("node:events");
  return { autoUpdater: new EventEmitter() };
});
vi.mock("../src/runtime.ts", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/runtime.ts")>();
  const create = real.RuntimeSupervisor.create.bind(real.RuntimeSupervisor);
  real.RuntimeSupervisor.create = async (...args: Parameters<typeof create>) => {
    const supervisor = await create(...args);
    started.push(supervisor);
    return supervisor;
  };
  return real;
});

const { fake } = await import("./fakeElectron.ts");
const { BUG_REPORT_DONE_CHANNEL } = await import("../src/ipc.ts");

afterAll(async () => {
  await Promise.all(started.map((supervisor) => supervisor.stop()));
});

it("opens the startup recovery window when its runtime's files are missing, with what the runtime said and a problem report", async () => {
  const entry = join(mkdtempSync(join(tmpdir(), "caveman-desktop-no-runtime-")), "bin.mjs");
  process.env.CAVEMAN_RUNTIME_ENTRY = entry;
  await import("../src/main.ts");
  fake.ready();
  // The supervisor's fast restarts first (0.5 + 1 + 2 + 4 + 8 s), as for any runtime that keeps exiting at start.
  const recoveryWindow = () =>
    fake.windows.find((w) => w.options.title === "Caveman Code can't start");
  const deadline = Date.now() + 40_000;
  while (!recoveryWindow() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
  const recovery = recoveryWindow()!;
  const page = decodeURIComponent(
    recovery.webContents.url.replace(/^data:text\/html;charset=utf-8,/, ""),
  );
  expect({
    title: page.includes("Caveman Code&#39;s runtime keeps stopping"),
    said: page.includes(`Cannot find module &#39;${entry}&#39;`),
    actions: [...page.matchAll(/startup-recovery\.invalid\/(\w+)/g)].map((m) => m[1]),
    questions: fake.questions,
  }).toEqual({
    title: true,
    said: true,
    actions: ["download", "retry", "report", "copy", "logs", "quit"],
    questions: [],
  });

  // Report a problem: the app's window opens the report, prepared from this app's logs; closing it asks again.
  const main = fake.windows[0]!;
  main.webContents.finishLoad();
  recovery.emit("ready-to-show");
  recovery.webContents.emit(
    "will-navigate",
    { preventDefault: () => undefined },
    "https://startup-recovery.invalid/report",
  );
  const hidden = !recovery.isVisible();
  const opened =
    main.webContents.scripts.find((script) => script.includes("caveman:report-problem")) ?? "";
  fake.ipc(BUG_REPORT_DONE_CHANNEL);
  expect({
    hidden,
    mainShown: main.isVisible(),
    surface: opened.includes(`"surface":"runtime"`),
    name: opened.includes(`"name":"RuntimeKeepsStopping"`),
    backAfterReport: recovery.isVisible(),
  }).toEqual({
    hidden: true,
    mainShown: true,
    surface: true,
    name: true,
    backAfterReport: true,
  });

  // Closed (Windows has no Dock to bring it back): opening the app again shows the choices again.
  recovery.destroy();
  fake.app.emit("second-instance", {}, []);
  await new Promise((r) => setTimeout(r, 0));
  const reopened = fake.windows
    .filter((w) => w.options.title === "Caveman Code can't start")
    .at(-1)!;
  expect({ another: reopened !== recovery, open: !reopened.isDestroyed() }).toEqual({
    another: true,
    open: true,
  });
}, 60_000);
