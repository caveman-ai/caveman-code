// A warm Cloud computer's identity, taken by the runtime itself while it waits for its claim (Caveman Cloud the spec,
// kind reviews K6, K10). The computers service made the pod before it belonged to any computer, with a bootstrap
// file of its own in its link Secret (CAVEMAN_RUNTIME_LINK_BOOTSTRAP): Cloud's origin, a random token and an X25519
// private key. This long-polls Cloud's bootstrap route with the token. At the claim the computers service seals the
// computer's identity to the pod's public key and Cloud answers at once; only this pod's key opens it. kubelet's copy
// of the pod's Secret, beside the bootstrap file, is the fallback: whichever is whole first goes into the link dir,
// runtime.key first, each renamed into place. The same as the image's link-bootstrap.mjs, in the runtime's own process
// instead of a second Node process beside it (about 150 MiB under gVisor).
import { createDecipheriv, createPrivateKey, createPublicKey, diffieHellman, hkdfSync } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

import { KEY_FILE, RECORD_FILE } from "./identity.ts";

/** HKDF info and AES-GCM additional data of the sealed format (Caveman Cloud Sandboxes). */
export const SEAL_INFO = "caveman computer bootstrap v1";

const IDENTITY = [KEY_FILE, RECORD_FILE] as const;
type Files = Record<(typeof IDENTITY)[number], Buffer>;

const whole = (dir: string) => IDENTITY.every((name) => fs.existsSync(path.join(dir, name)));
const raw = (key: ReturnType<typeof createPublicKey>) => Buffer.from(key.export({ format: "jwk" }).x!, "base64url");

/** Opens a sealed identity (format 1: 0x01, the ephemeral X25519 key, the nonce, AES-256-GCM) with the pod's PKCS #8 DER key. */
export function openSealed(keyDer: Buffer, sealed: Buffer): Files {
  if (sealed.length < 1 + 32 + 12 + 16 || sealed[0] !== 1) throw new Error("not a sealed identity");
  const privateKey = createPrivateKey({ key: keyDer, format: "der", type: "pkcs8" });
  const ephemeral = sealed.subarray(1, 33);
  const publicKey = createPublicKey({ key: { kty: "OKP", crv: "X25519", x: ephemeral.toString("base64url") }, format: "jwk" });
  const shared = diffieHellman({ privateKey, publicKey });
  const key = Buffer.from(hkdfSync("sha256", shared, Buffer.concat([ephemeral, raw(createPublicKey(privateKey))]), SEAL_INFO, 32));
  const decipher = createDecipheriv("aes-256-gcm", key, sealed.subarray(33, 45));
  decipher.setAAD(Buffer.from(SEAL_INFO));
  decipher.setAuthTag(sealed.subarray(sealed.length - 16));
  const plain = Buffer.concat([decipher.update(sealed.subarray(45, sealed.length - 16)), decipher.final()]);
  const files = JSON.parse(plain.toString("utf8")) as Record<string, string>;
  for (const name of IDENTITY) if (typeof files[name] !== "string") throw new Error(`the sealed identity has no ${name}`);
  return { [KEY_FILE]: Buffer.from(files[KEY_FILE]!, "base64"), [RECORD_FILE]: Buffer.from(files[RECORD_FILE]!, "base64") } as Files;
}

interface BootFile {
  readonly cloud_url: string;
  readonly token: string;
  readonly key: string;
}

// The signal outlives every pause (a warm pod polls four times a second until its claim): each takes its listener off.
const pause = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    const abort = () => (clearTimeout(timer), reject(signal.reason));
    const timer = setTimeout(() => (signal.removeEventListener("abort", abort), resolve()), ms);
    signal.addEventListener("abort", abort, { once: true });
  });

/** Asks Cloud until it answers with this pod's identity: 204 is "not claimed yet, ask again"; a failure waits a little. */
export async function askCloud(boot: BootFile, options: { readonly signal: AbortSignal; readonly fetch?: typeof fetch; readonly log?: (line: string) => void }): Promise<Files> {
  const url = `${boot.cloud_url.replace(/\/+$/, "")}/api/v1/code/runtime/bootstrap`;
  const call = options.fetch ?? fetch;
  for (let failures = 0; ; ) {
    options.signal.throwIfAborted();
    const asked = Date.now();
    try {
      const response = await call(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token: boot.token }),
        signal: AbortSignal.any([options.signal, AbortSignal.timeout(60_000)]),
      });
      if (response.status === 200) {
        const body = (await response.json()) as { sealed?: string };
        return openSealed(Buffer.from(boot.key, "base64"), Buffer.from(body.sealed ?? "", "base64"));
      }
      await response.body?.cancel();
      if (response.status === 204) {
        // Cloud holds the ask until the claim or its long poll ends; one it answers at once is asked again a second on.
        failures = 0;
        if (Date.now() - asked < 1_000) await pause(1_000 - (Date.now() - asked), options.signal);
        continue;
      }
      options.log?.(`the bootstrap route answered ${response.status}; asking again`);
    } catch (error) {
      options.signal.throwIfAborted();
      options.log?.(`the bootstrap route failed (${(error as Error).message}); asking again`);
    }
    failures++;
    await pause(Math.min(5_000, 250 * 2 ** Math.min(failures, 5)), options.signal);
  }
}

/** kubelet's copy of the pod's Secret in `dir`, once both files are there (kubelet swaps them in whole). */
async function mounted(dir: string, everyMs: number, signal: AbortSignal): Promise<Files> {
  while (!whole(dir)) await pause(everyMs, signal);
  return { [KEY_FILE]: fs.readFileSync(path.join(dir, KEY_FILE)), [RECORD_FILE]: fs.readFileSync(path.join(dir, RECORD_FILE)) } as Files;
}

/** Puts the identity into `dir`: runtime.key, then runtime.json, each whole before it is there. */
export function place(dir: string, files: Files): void {
  for (const name of IDENTITY) {
    const tmp = path.join(dir, `.${name}.tmp`);
    fs.writeFileSync(tmp, files[name], { mode: 0o600 });
    fs.renameSync(tmp, path.join(dir, name));
  }
}

/**
 * The identity from whichever comes first, Cloud's bootstrap route or kubelet's copy beside `bootFile`, placed in
 * `linkDir`; "kept" when `linkDir` already holds one (a restart after the claim). `signal` stops both.
 */
export async function takeIdentity(input: {
  readonly bootFile: string;
  readonly linkDir: string;
  readonly signal: AbortSignal;
  readonly fetch?: typeof fetch;
  readonly everyMs?: number;
  readonly log?: (line: string) => void;
}): Promise<"kept" | "the bootstrap route" | "kubelet's copy"> {
  if (whole(input.linkDir)) return "kept";
  const stop = new AbortController();
  const signal = AbortSignal.any([input.signal, stop.signal]);
  const copy = mounted(path.dirname(input.bootFile), input.everyMs ?? 250, signal).then((files) => ({ files, from: "kubelet's copy" as const }));
  let boot: BootFile | undefined;
  try {
    boot = JSON.parse(fs.readFileSync(input.bootFile, "utf8")) as BootFile;
  } catch (error) {
    input.log?.(`no bootstrap file to ask Cloud with (${(error as Error).message}); waiting for kubelet's copy`);
  }
  const route = boot === undefined ? undefined : askCloud(boot, { signal, ...(input.fetch ? { fetch: input.fetch } : {}), ...(input.log ? { log: input.log } : {}) }).then((files) => ({ files, from: "the bootstrap route" as const }));
  try {
    // The first that succeeds: a copy that cannot be read leaves the route asking.
    const { files, from } = await Promise.any(route === undefined ? [copy] : [route, copy]);
    place(input.linkDir, files);
    return from;
  } catch (error) {
    input.signal.throwIfAborted();
    throw error;
  } finally {
    stop.abort();
  }
}
