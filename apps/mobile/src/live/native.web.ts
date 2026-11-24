// The web build's side of native.ts. The phone app in a browser is a preview for development, not a product: a
// browser has no Keychain, so the two secrets sit in localStorage here, which any script on the page can read. The
// product's web client (apps/web) keeps its device key unextractable in IndexedDB instead.
import type { SecretStore } from "./cloud";

export const secrets: SecretStore = {
  get: async (key) => localStorage.getItem(key),
  set: async (key, value) => localStorage.setItem(key, value),
  delete: async (key) => localStorage.removeItem(key),
};

/**
 * A browser has WebCrypto of its own, and it serves. `?jscrypto` in the address puts the phone's in its place
 * (webcrypto.ts), to run that in a real browser against a real computer.
 */
export async function installCrypto(): Promise<void> {
  if (!new URLSearchParams(location.search).has("jscrypto")) return;
  const { installWebCrypto } = await import("./webcrypto");
  installWebCrypto({ force: true });
}

/** What the Mac's Allow dialog calls this device. */
export const deviceName = () => "Phone preview";

/** Opens Caveman's sign-in page in another tab. */
export const openUrl = (url: string) => void window.open(url, "_blank", "noopener");
