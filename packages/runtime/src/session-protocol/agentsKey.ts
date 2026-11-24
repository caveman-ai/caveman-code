// This Mac's agents key (session-protocol macMail.ts): the P-256 key its chats sign mail to the person's other Macs
// with. The desktop app makes it once, keeps it sealed in the keychain (apps/desktop agentsKey.ts) and hands it to its
// runtime on the private bootstrap descriptor; the runtime keeps it in memory only, never on disk or in the
// environment, so an engine's tools cannot read it as they can read a file in the state dir. A runtime without the
// desktop app has none, and sends and takes no mail between Macs.
import { createPrivateKey, createPublicKey, sign } from "node:crypto";

import { deviceIdOf, publicKeyOf, type DeviceKey } from "@caveman-app/session-protocol";

/** The key in `pem` (PKCS#8, P-256) as a signer: ECDSA P-256 with SHA-256, r||s, as WebCrypto signs. Undefined for none. */
export async function agentsKeyOf(pem: string | undefined): Promise<DeviceKey | undefined> {
  if (pem === undefined || pem.trim() === "") return undefined;
  const key = createPrivateKey({ key: pem, format: "pem" });
  if (key.asymmetricKeyType !== "ec" || key.asymmetricKeyDetails?.namedCurve !== "prime256v1") throw new Error("the agents key is not a P-256 key");
  const public_key = publicKeyOf(createPublicKey(key).export({ format: "jwk" }));
  if (!public_key) throw new Error("the agents key is not a P-256 key");
  return { device_id: await deviceIdOf(public_key), name: "agents", public_key, sign: async (data) => new Uint8Array(sign("sha256", data, { key, dsaEncoding: "ieee-p1363" })) };
}
