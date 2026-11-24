import * as Layer from "effect/Layer";

import * as ProjectionStore from "../ProjectionStore.ts";
import { layerPendingTranscriptAttachments } from "./LegacyV1ThreadImporter.ts";

/**
 * The SQLite projection store with the legacy importer's reader of pending V1 transcripts, which
 * attachment history needs (AttachmentHistory.ts). The runtime builds this one store
 * (runtimeLayer.ts, server.ts); tests over a migrated database use it too.
 */
export const layer = ProjectionStore.layer.pipe(Layer.provide(layerPendingTranscriptAttachments));
