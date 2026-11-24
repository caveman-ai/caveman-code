// What the phone's connection takes from the platform, on iOS and Android (the web build's is native.web.ts): where
// its two secrets are kept, the system's random bytes, WebCrypto, the browser for Caveman's sign-in page, and what
// this device is called on the Mac's Allow dialog.
import * as ExpoCrypto from "expo-crypto";
import * as SecureStore from "expo-secure-store";
import { Linking, Platform } from "react-native";

import type { SecretStore } from "./cloud";
import { installWebCrypto } from "./webcrypto";

// The Keychain on iOS, a Keystore-encrypted store on Android: readable only while the phone is unlocked, and never
// restored to another device from a backup. The device key and the Caveman sign-in live here and nowhere else.
const KEPT: SecureStore.SecureStoreOptions = {
  keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
};

export const secrets: SecretStore = {
  get: (key) => SecureStore.getItemAsync(key, KEPT),
  set: (key, value) => SecureStore.setItemAsync(key, value, KEPT),
  delete: (key) => SecureStore.deleteItemAsync(key, KEPT),
};

/**
 * A phone's JavaScript engine has no WebCrypto, so the protocol's device code gets the phone's own (webcrypto.ts, the
 * noble libraries) on the system's random bytes. Called as the app starts (index.ts), before anything asks for it;
 * calling it again does nothing.
 */
export async function installCrypto(): Promise<void> {
  // The system fills integer arrays in place, which is all WebCrypto's getRandomValues takes.
  installWebCrypto({
    getRandomValues: (array) =>
      ExpoCrypto.getRandomValues(array as unknown as Uint8Array) as unknown as typeof array,
  });
}

/** What the Mac's Allow dialog calls this device. */
export const deviceName = () =>
  Platform.OS === "ios" ? (Platform.isPad ? "iPad" : "iPhone") : "Android phone";

/** Opens Caveman's sign-in page in the phone's browser. */
export const openUrl = (url: string) => void Linking.openURL(url).catch(() => undefined);
