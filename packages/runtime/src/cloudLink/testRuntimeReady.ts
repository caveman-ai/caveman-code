import fs from "node:fs";

/** Test children signal readiness by publishing their complete connection details. */
export const publishTestRuntimeReady = (file: string, info: Record<string, unknown>): void => {
  // The parent treats existence as readiness. Rename only after the entire document is written.
  const pending = `${file}.tmp`;
  fs.writeFileSync(pending, JSON.stringify(info));
  fs.renameSync(pending, file);
};
