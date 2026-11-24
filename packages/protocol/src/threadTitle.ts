// ), packages/contracts/src/threadTitle.ts @ ab3a3cd1.
import * as Schema from "effect/Schema";

import { CommandId, IsoDateTime } from "./baseSchemas.ts";

/** An in-flight title regeneration, as MCP thread metadata reports it. */
export const ThreadTitleRegeneration = Schema.Struct({
  requestId: CommandId,
  startedAt: IsoDateTime,
});
export type ThreadTitleRegeneration = typeof ThreadTitleRegeneration.Type;
