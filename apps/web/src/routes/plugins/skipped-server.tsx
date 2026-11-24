// A server Claude Agent leaves out of new chats because it timed out connecting (mcp.skipped), with Retry (mcp.retry).
import { Button } from "@caveman-app/ui/components/button";
import { Tag } from "@caveman-app/ui/components/tag";

/** The key Claude Agent knows a server by (the runtime's resolve.ts): a personal one's name, a plugin's `<plugin>__<server>`. */
export const serverKey = (name: string) => name.replace(/[^A-Za-z0-9_-]/g, "_");

/** A server Claude Agent leaves out of new chats (mcp.skipped): its tag, Retry, and why. */
export function skippedServer(at: string, until: string, onRetry: () => void) {
  const time = (iso: string) => new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
  return {
    tag: (
      <Tag tone="yellow" title="Claude Agent leaves it out of new chats">
        Skipped
      </Tag>
    ),
    retry: (
      <Button size="sm" onClick={onRetry}>
        Retry
      </Button>
    ),
    note: (
      <p className="mb-2 text-[12px] text-warning">
        It did not connect within 30 seconds when a chat started ({time(at)}), so Claude Agent leaves it out of new chats until {time(until)}, or sooner if a
        check finds it answering. Retry to try it in the next chat.
      </p>
    ),
  };
}
