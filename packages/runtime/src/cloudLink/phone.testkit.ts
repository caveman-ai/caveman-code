// Test helpers for the phone's connection (apps/mobile/src/live): a phone and a Mac in one test process, each on its
// own WebCrypto. The protocol's device code reads `globalThis.crypto` (session-protocol devices.ts), and a process has
// one. So while a test holds `splitCrypto`, that global answers by who asks: what runs inside `asPhone` (the phone's
// modules, and everything they start: their sockets, timers and promises) gets the phone's WebCrypto on the noble
// libraries (apps/mobile/src/live/webcrypto.ts), forced on though Node has its own; the runtime, the stand-in Cloud
// and the test itself keep Node's. A hello the phone signs is then verified, and every sealed frame opened, by the
// other implementation, over the real wire, as on a real phone and a real Mac.
import { AsyncLocalStorage } from "node:async_hooks";
import { webcrypto } from "node:crypto";

import type { RtcPeerConstructor } from "@caveman-app/session-protocol/direct";

import { subtle as phoneSubtle } from "../../../../apps/mobile/src/live/webcrypto.ts";
import type { SecretStore } from "../../../../apps/mobile/src/live/cloud.ts";

const onPhone = new AsyncLocalStorage<true>();

/** How many WebCrypto calls each side made: a test checks neither ran on the other's by a slip. */
export const cryptoCalls = { phone: 0, mac: 0 };

const counted = <T extends object>(subtle: T, side: "phone" | "mac"): T =>
  new Proxy(subtle, {
    get(target, key) {
      const value = Reflect.get(target, key, target) as unknown;
      if (typeof value !== "function") return value;
      return (...args: Array<unknown>) => {
        cryptoCalls[side]++;
        return (value as (...a: Array<unknown>) => unknown).apply(target, args);
      };
    },
  });

/**
 * Puts the two WebCryptos in place until the returned function is called. Node's own keeps serving everything outside
 * `asPhone`.
 */
export function splitCrypto(): () => void {
  const real = Object.getOwnPropertyDescriptor(globalThis, "crypto")!;
  const random = {
    getRandomValues: <T extends ArrayBufferView>(array: T) =>
      webcrypto.getRandomValues(array as never) as unknown as T,
    randomUUID: () => webcrypto.randomUUID(),
  };
  const phone = { subtle: counted(phoneSubtle, "phone"), ...random };
  const mac = { subtle: counted(webcrypto.subtle, "mac"), ...random };
  Object.defineProperty(globalThis, "crypto", {
    configurable: true,
    enumerable: true,
    get: () => (onPhone.getStore() ? phone : mac),
  });
  return () => Object.defineProperty(globalThis, "crypto", real);
}

/** Runs `run` as the phone: it, and whatever it starts, sees the phone's WebCrypto. */
export const asPhone = <T>(run: () => T): T => onPhone.run(true, run);

/**
 * A WebRTC implementation whose events reach the phone's code as the phone. A native module's callbacks arrive outside
 * any async context, where `asPhone` no longer holds, so each handler set on a peer or on its channel is bound to the
 * context that set it.
 */
export function asPhoneRtc(Rtc: RtcPeerConstructor): RtcPeerConstructor {
  const bound = <T extends object>(target: T): T =>
    new Proxy(target, {
      get(inner, key) {
        const value = Reflect.get(inner, key, inner) as unknown;
        if (typeof value !== "function") return value;
        return (...args: Array<unknown>) => {
          const out = (value as (...a: Array<unknown>) => unknown).apply(inner, args);
          return key === "createDataChannel" ? bound(out as object) : out;
        };
      },
      set: (inner, key, value) =>
        Reflect.set(
          inner,
          key,
          typeof value === "function" && typeof key === "string" && key.startsWith("on")
            ? AsyncLocalStorage.bind(value as () => void)
            : value,
          inner,
        ),
    });
  return function (config: ConstructorParameters<RtcPeerConstructor>[0]) {
    return bound(new Rtc(config));
  } as unknown as RtcPeerConstructor;
}

/** A phone's Keychain, in memory: what it holds can be read back by a test (what is kept, and that nothing else is). */
export function memorySecrets(): SecretStore & { readonly entries: Map<string, string> } {
  const entries = new Map<string, string>();
  return {
    entries,
    get: async (key) => entries.get(key) ?? null,
    set: async (key, value) => void entries.set(key, value),
    delete: async (key) => void entries.delete(key),
  };
}
