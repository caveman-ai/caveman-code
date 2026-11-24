// Seams for device approval when a device drives a laptop's runtime through the relay (DESIGN S13, lane R). This
// lane's connections and Cloud calls ask here; R registers what its device keys and approval need. Unregistered, a
// connection runs no handshake and a queued call carries no extra fields, as before S13.
import type { Handshake } from "@caveman-app/session-protocol/client";
import type { QueuedCallBody } from "./sender.ts";

export interface DeviceHooks {
  /** The first exchange on a connection to `runtimeId` (a laptop runtime asks for `device.hello`); none: undefined. */
  readonly handshake?: (runtimeId: string) => Handshake | undefined;
  /**
   * Fields added to a call queued in Cloud, awaited before it is posted: `device` (signCall over this call), for a
   * laptop to approve it by. `call.params` is exactly what is posted, after a JSON round trip.
   */
  readonly callFields?: (call: QueuedCallBody) => Promise<Readonly<Record<string, unknown>>>;
  /**
   * Fields added to a person's move posted to Cloud (Move to on a device that does not hold the chat): `device`
   * (signMove over the session, the request id and `to`). A Mac lets a chat go only for a device it allowed (S-R4).
   */
  /**
   * Whether this device still waits for `runtimeId` to allow it (its handshake said pending or refused); null once
   * allowed, or never asked (a Cloud computer). Reading never needs it (Cloud's copy); driving does (K4).
   */
  readonly approval?: (runtimeId: string) => DeviceApproval | null;
  /** approval() may have changed for some runtime. */
  readonly onApproval?: (listener: () => void) => () => void;
  readonly moveFields?: (move: { readonly session_id: string; readonly request_id: string; readonly to: "cloud" | { readonly computer_id: string } }) => Promise<Readonly<Record<string, unknown>>>;
}

/** What this device waits for on a laptop's runtime before it may drive it (S13), in words for the pane. */
export interface DeviceApproval {
  /** pending: the Mac has not answered yet; refused: it said no. */
  readonly state: "pending" | "refused";
  /** "Waiting for MacBook Pro to allow this browser". */
  readonly title: string;
  /** What to do on the Mac, with the code it shows. */
  readonly detail: string;
}

let hooks: DeviceHooks = {};

/** Installs the device hooks (once, as the app starts, before the runtime provider connects). */
export function registerDeviceHooks(next: DeviceHooks): void {
  hooks = next;
}

export const deviceHooks = (): DeviceHooks => hooks;
