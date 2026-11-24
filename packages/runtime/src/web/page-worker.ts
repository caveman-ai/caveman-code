// web_fetch's page reader (pageProcess.ts), a child process: sent { input } with a fetched body over IPC, it answers
// { page } (with its index, pages.ts indexPage) or { error }. While it reads, a thread of its own writes the process's memory (RSS, in bytes) to
// REPORT_FD every REPORT_MS, so the runtime can kill it before a page balloons; a parse busy on the main thread
// can't hold a report back.
import { Worker } from "node:worker_threads";

import { REPORT_FD, REPORT_MS } from "./pageProcess.ts";
import { indexPage } from "./pages.ts";
import { toPage, type PageInput } from "./pageText.ts";

const reading = new Int32Array(new SharedArrayBuffer(4));
const reporter = new Worker(
  `const { workerData: { reading, fd, everyMs } } = require("node:worker_threads");
  const { writeSync } = require("node:fs");
  setInterval(() => {
    if (Atomics.load(reading, 0) !== 1) return;
    try { writeSync(fd, process.memoryUsage.rss() + "\\n"); } catch {}
  }, everyMs);`,
  { eval: true, workerData: { reading, fd: REPORT_FD, everyMs: REPORT_MS } },
);
reporter.unref();

process.on("message", async ({ input }: { input: PageInput }) => {
  Atomics.store(reading, 0, 1);
  try {
    const page = await toPage(input);
    // Indexed here too, so the runtime's thread never scores a whole page.
    process.send!({ page: { ...page, index: indexPage(page.markdown) } });
  } catch (error) {
    process.send!({ error: error instanceof Error ? error.message : String(error) });
  } finally {
    Atomics.store(reading, 0, 0);
  }
});
// The runtime is gone: so is its reader.
process.on("disconnect", () => process.exit(0));
