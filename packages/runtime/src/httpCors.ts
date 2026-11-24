// ), apps/server/src/httpCors.ts @ ab3a3cd1.
import { ORCHESTRATION_PROTOCOL_HEADER } from "@caveman-app/protocol";

export const browserApiCorsAllowedMethods = ["GET", "POST", "OPTIONS"] as const;
export const browserApiCorsAllowedHeaders = [
  "authorization",
  "b3",
  "traceparent",
  "content-type",
  ORCHESTRATION_PROTOCOL_HEADER,
] as const;

/** Origins of the Electron renderer, packaged and dev. */
export const DESKTOP_RENDERER_ORIGINS = ["caveman-code://app"] as const;
