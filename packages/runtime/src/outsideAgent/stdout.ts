// Stdout belongs to MCP's JSON-RPC alone (docs/ §2.9): imported first by
// cli/mcp.ts, before anything that could print, it sends every console method that writes to stdout to stderr.
import { Console } from "node:console";

const stderr = new Console({ stdout: process.stderr, stderr: process.stderr });
const toStderr = ["log", "info", "debug", "dir", "dirxml", "table", "group", "groupCollapsed", "groupEnd", "count", "countReset", "time", "timeLog", "timeEnd"] as const;
for (const method of toStderr) (console as unknown as Record<string, unknown>)[method] = (stderr[method] as (...args: Array<unknown>) => void).bind(stderr);
