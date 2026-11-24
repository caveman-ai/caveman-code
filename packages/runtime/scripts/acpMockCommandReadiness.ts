import * as NodeFS from "node:fs";
import * as Effect from "effect/Effect";

/** The provider-exit fixture must start its command before testing how termination reaps it. */
export const waitForAcpMockCommandPids = (path: string, count: number): Effect.Effect<void> =>
  Effect.gen(function* () {
    while (true) {
      const ready = yield* Effect.sync(() => {
        try {
          const pids = NodeFS.readFileSync(path, "utf8")
            .trim()
            .split(/\s+/)
            .filter(Boolean)
            .map(Number);
          return pids.length === count && pids.every((pid) => Number.isSafeInteger(pid) && pid > 1);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
          throw error;
        }
      });
      if (ready) return;
      yield* Effect.sleep("10 millis");
    }
  }).pipe(
    Effect.timeout("2 seconds"),
    // Failed fixture setup is fatal, not an ACP prompt protocol error.
    Effect.orDie,
  );
