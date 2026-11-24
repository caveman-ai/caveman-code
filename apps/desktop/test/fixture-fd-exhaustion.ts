// A desktop main process that has used every file descriptor it may open, as one that leaks them does: run under
// `ulimit -n`, it takes all that are left, starts a RuntimeSupervisor on the fixture runtime, and prints what happened
// as one JSON line. The descriptors come back when the supervisor reports the failed run, before the restart it
// schedules, so that restart has them; only then does this process use any itself.
import { closeSync, openSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { RuntimeSupervisor } from "../src/runtime.ts";

const fixture = fileURLToPath(new URL("./fixture-runtime.mjs", import.meta.url));
const held: number[] = [];
let given!: () => void;
const givenBack = new Promise<void>((done) => (given = done));
const giveBack = () => {
  for (const fd of held.splice(0)) closeSync(fd);
  given();
};
// Electron's main shows its error dialog for these; this process records them instead.
const uncaught: string[] = [];
process.on("uncaughtException", (error) => {
  uncaught.push(error.message);
  giveBack();
});
process.on("unhandledRejection", (error) =>
  uncaught.push(error instanceof Error ? error.message : String(error)),
);

const lines: string[] = [];
const exits: Array<number | null> = [];
const supervisor = await RuntimeSupervisor.create(
  {
    command: process.execPath,
    args: [fixture, "--bootstrap-fd", "3"],
    env: process.env,
    cwd: process.cwd(),
  },
  (line) => lines.push(line),
  {
    restartMinMs: 10,
    onUnexpectedExit: (code) => {
      exits.push(code);
      giveBack();
    },
  },
);
try {
  for (;;) held.push(openSync("/dev/null", "r"));
} catch {
  // EMFILE: none left.
}
const exhausted = held.length > 0;
let threw: string | undefined;
try {
  supervisor.start();
} catch (error) {
  threw = (error as Error).message;
  giveBack();
}
await givenBack;
const ready = await supervisor.waitReady(10_000).then(
  (engines) => engines.map((e) => e.id),
  (error: Error) => error.message,
);
await supervisor.stop();
process.stdout.write(`${JSON.stringify({ exhausted, threw, uncaught, exits, ready, lines })}\n`);
