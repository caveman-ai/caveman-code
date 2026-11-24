// Devices that drive This Mac through Caveman Cloud (DESIGN S13): on the device in your hand, the line that says the
// Mac has not allowed it yet; on the Mac, the "Allow?" question and Settings' list of devices with Remove. Only the
// Mac's own screen can allow one: these calls are refused through the relay (session-protocol devices.ts). In the
// desktop app the Allow and Remove are also signed with this Mac's key, so the person's other Macs that take its
// approvals allow or remove the device too (devices-model.ts).
import type { Client, DeviceList, DeviceRequest } from "@caveman-app/session-protocol";
import { deviceCode, normalizePairingCode, type DeviceKey } from "@caveman-app/session-protocol/devices";
import { Button } from "@caveman-app/ui/components/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@caveman-app/ui/components/dialog";
import { Input } from "@caveman-app/ui/components/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@caveman-app/ui/components/select";
import { Switch } from "@caveman-app/ui/components/switch";
import { useCallback, useEffect, useId, useState, useSyncExternalStore } from "react";

import { chosenRuntime } from "../state/cloud.ts";
import { deviceStatusOf, joinMac, subscribeDeviceStatus, waitingCopy } from "../state/device-approval.ts";
import { deviceName, keepVouching, thisDevice } from "../state/device-key.ts";
import {
  allowedCopy,
  allowStatement,
  joinTargets,
  notSharedCopy,
  ownCodeCopy,
  pairingAnnouncement,
  pairingCopy,
  promptPick,
  removeConfirmCopy,
  removedCopy,
  removeStatement,
  requestCopy,
  requestRowCopy,
  upgradeOf,
  waitingCountCopy,
} from "./devices-model.ts";
import { CLOUD_HOSTED, requestId, useChatList, useRuntimeClient, useRuntimeSelector, useSyncHub } from "../state/runtime.tsx";
import { CONTROL, SettingRow, SettingsCard, useSaveSettings } from "../routes/settings/rows.tsx";

/** How long the "Allow?" dialog's Allow waits after the request it shows changes (A-2): a click meant for the last one never lands on it. */
const ALLOW_HOLD_MS = 1_000;

const myName = () => deviceName(globalThis.navigator?.userAgent ?? "", globalThis.navigator?.maxTouchPoints ?? 0);

/** On a device reaching a Mac through Caveman Cloud: one line while the Mac has not allowed it. */
export function DeviceWaiting() {
  const runtimeId = CLOUD_HOSTED ? (chosenRuntime(localStorage)?.id ?? null) : null;
  const status = useSyncExternalStore(subscribeDeviceStatus, () => deviceStatusOf(runtimeId));
  const copy = waitingCopy(status, myName());
  if (!copy) return null;
  return (
    <div role="status" aria-live="polite" className="pointer-events-none fixed inset-x-0 top-3 z-50 flex justify-center px-4">
      <div className="pointer-events-auto flex max-w-[560px] items-start gap-3 rounded-xl border border-border bg-popover px-3 py-2 text-[13px] text-popover-foreground shadow-overlay">
        <span
          aria-hidden
          className={`mt-1.5 size-1.5 shrink-0 rounded-full ${status?.status === "pending" ? "animate-pulse bg-warning motion-reduce:animate-none" : "bg-destructive"}`}
        />
        <span className="min-w-0">
          <span className="block font-medium">{copy.title}</span>
          <span className="block text-[12.5px] text-muted-foreground">{copy.detail}</span>
        </span>
      </div>
    </div>
  );
}

// The requests the "Allow?" dialog was closed on without an answer: Getting started lists them (shell/GettingStarted.tsx)
// until they are answered, and its step asks again.
type PutOff = ReadonlyArray<{ readonly id: string; readonly name: string }>;
let putOff: PutOff = [];
const putOffListeners = new Set<() => void>();
const subscribePutOff = (listener: () => void) => {
  putOffListeners.add(listener);
  return () => void putOffListeners.delete(listener);
};
/** Hidden from Getting started with its card: they wait in Settings, Devices alone. */
const putOffHidden = new Set<string>();
function setPutOff(all: PutOff) {
  const next = all.filter((d) => !putOffHidden.has(d.id));
  if (next.length === putOff.length && next.every((d, i) => d.id === putOff[i]!.id && d.name === putOff[i]!.name)) return;
  putOff = next;
  for (const listener of putOffListeners) listener();
}
/** Getting started's Hide: the devices it lists leave it (their requests still wait in Settings, Devices). */
export function hideDevicesPutOff(): void {
  for (const d of putOff) putOffHidden.add(d.id);
  setPutOff([]);
}
/** Devices waiting on this Mac whose question was closed unanswered, oldest first. */
export const useDevicesPutOff = (): PutOff => useSyncExternalStore(subscribePutOff, () => putOff);
const ASK_AGAIN = "caveman:devices-ask-again";
/** Getting started's step: the "Allow?" question again, for every device it was closed on. */
export const askDevicesAgain = (): void => void window.dispatchEvent(new Event(ASK_AGAIN));

/** device.list from this computer's runtime, kept fresh by device.changed; null where it is not ours to manage. */
function useDeviceList(): { readonly list: DeviceList | null; readonly refresh: () => void } {
  const { client, connection } = useRuntimeClient();
  const [list, setList] = useState<DeviceList | null>(null);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!client || CLOUD_HOSTED) return setList(null);
    let live = true;
    const off = client.on("device.changed", (next) => live && setList(next));
    client.call("device.list", {}).then(
      (next) => live && setList(next),
      // Not served (a relayed connection, an older runtime): nothing to manage here.
      () => live && setList(null),
    );
    return () => {
      live = false;
      off();
    };
  }, [client, connection, tick]);
  return { list, refresh: useCallback(() => setTick((n) => n + 1), []) };
}

/**
 * On This Mac: "iPhone, Safari wants to drive this Mac. Allow?" for each device that asks, oldest first. The request it
 * shows stays until it is answered or dismissed, whatever arrives meanwhile (A-2), and when the shown request changes
 * the dialog starts afresh (focus on Don't allow) with its Allow held a moment, so a click or a double-click meant for
 * one request never answers another.
 */
export function DeviceRequestPrompt() {
  const { client } = useRuntimeClient();
  const { list } = useDeviceList();
  const [asked, setAsked] = useState<DeviceRequest[]>([]);
  /** Closed without an answer: it waits in Settings, Devices, and is not asked again in this window. */
  const [dismissed, setDismissed] = useState<ReadonlySet<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** The device the dialog shows: kept until answered or dismissed (promptPick). */
  const [shown, setShown] = useState<string | null>(null);
  /** The shown request whose Allow is free: one shown a moment ago is not yet (from its very first frame). */
  const [released, setReleased] = useState<string | null>(null);
  /** Requests this dialog answered (device and time), out of it before the list says so: a second click lands on none. */
  const [answered, setAnswered] = useState<ReadonlySet<string>>(new Set());
  useEffect(() => {
    if (!client || CLOUD_HOSTED) return;
    return client.on("device.request", (request) => setAsked((all) => [...all.filter((r) => r.device_id !== request.device_id), request]));
  }, [client]);
  // In the desktop app this screen vouches for its own runtime's agents key by itself, once its sign-in names the
  // person (device-key.ts vouchAgentsKey: once per runtime and person). A failure (the keychain locked, the runtime
  // busy) is tried again a little later each time, and on every refresh of the list, until it went.
  const organization = list?.family?.organization_id;
  const person = list?.family?.user_id;
  useEffect(() => {
    if (!client || CLOUD_HOSTED || !organization || !person) return;
    return keepVouching(client, { organization_id: organization, user_id: person });
  }, [client, organization, person, list]);
  // Requests still waiting on the runtime (one asked before this window opened, or answered on another window).
  const waiting = (list ? list.requests : asked).filter((r) => !answered.has(`${r.device_id}@${r.at}`));
  // The ones closed unanswered wait in Getting started, whose step opens the question again.
  const later = list?.required ? waiting.filter((r) => dismissed.has(r.device_id)) : [];
  const laterKey = later.map((r) => `${r.device_id}\n${r.name}`).join("\n");
  useEffect(() => {
    setPutOff(later.map((r) => ({ id: r.device_id, name: r.name })));
    // Keyed by who waits: `later` is a fresh array on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [laterKey]);
  useEffect(() => () => setPutOff([]), []);
  useEffect(() => {
    const again = () => setDismissed(new Set());
    window.addEventListener(ASK_AGAIN, again);
    return () => window.removeEventListener(ASK_AGAIN, again);
  }, []);
  const pick = promptPick(waiting, dismissed, shown);
  const pickKey = pick?.key ?? null;
  const pickId = pick?.request.device_id ?? null;
  useEffect(() => {
    if (pickId !== shown) setShown(pickId);
  }, [pickId, shown]);
  useEffect(() => {
    if (pickKey === null) return;
    const timer = setTimeout(() => setReleased(pickKey), ALLOW_HOLD_MS);
    return () => clearTimeout(timer);
  }, [pickKey]);
  const current = pick?.request;
  if (!client || !pick || !current || !list?.required) return null;
  /** A device this Mac lets in already, joining with this Mac's code now to count as a Mac. */
  const known = upgradeOf(list, current) !== undefined;
  const copy = requestCopy(current, known);
  const others = waitingCountCopy(pick.index, pick.total);
  const answer = async (allow: boolean) => {
    setBusy(true);
    setError(null);
    try {
      if (allow) {
        // Signed for the person's other Macs where this is the desktop app; the kind is the one this dialog showed.
        const own = await thisDevice().catch(() => undefined);
        const statement = own ? await allowStatement(own, list, current) : undefined;
        await client.call("device.allow", { request_id: requestId(), device_id: current.device_id, role: current.role ?? "device", ...(statement ? { statement } : {}) });
      } else if (known) await client.call("device.allow", { request_id: requestId(), device_id: current.device_id, role: "device" });
      // Don't allow stays on this Mac.
      else await client.call("device.remove", { request_id: requestId(), device_id: current.device_id });
      setAsked((all) => all.filter((r) => r.device_id !== current.device_id));
      setAnswered((all) => new Set([...all, `${current.device_id}@${current.at}`]));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog key={pick.key} open onOpenChange={(open) => !open && !busy && setDismissed((all) => new Set([...all, current.device_id]))}>
      <DialogContent size="sm">
        <DialogHeader>
          <DialogTitle>{copy.title}</DialogTitle>
          <DialogDescription>{copy.detail}</DialogDescription>
        </DialogHeader>
        {others ? <p className="px-1 text-[12.5px] text-muted-foreground">{others}</p> : null}
        {error ? (
          <p role="alert" className="px-1 text-[12.5px] text-destructive">
            {error}
          </p>
        ) : null}
        <DialogFooter>
          <Button variant="outline" disabled={busy} onClick={() => void answer(false)}>
            {known ? "Keep as a device" : "Don't allow"}
          </Button>
          <Button disabled={busy || released !== pick.key} onClick={() => void answer(true)}>
            Allow
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

const when = (iso: string | undefined) =>
  iso ? new Date(iso).toLocaleDateString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : null;

/** Settings: the devices that may drive this Mac, the ones waiting and the ones blocked. */
export function DeviceSettings() {
  const { client } = useRuntimeClient();
  const settings = useRuntimeSelector((v) => v.settings);
  const save = useSaveSettings();
  const { list, refresh } = useDeviceList();
  const [error, setError] = useState<string | null>(null);
  /** This Mac's own key, where this is the desktop app: its code is what another of the person's Macs asks them to check. */
  const [own, setOwn] = useState<DeviceKey | undefined>(undefined);
  useEffect(() => {
    let live = true;
    thisDevice().then(
      (key) => live && setOwn(key.kind === "mac" ? key : undefined),
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, []);
  const id = useId();
  /** The device whose Remove waits for the person's yes (m-15): it signs a removal every Mac applies. */
  const [removing, setRemoving] = useState<DeviceList["devices"][number] | null>(null);
  if (!client || !list?.required) return null;
  /** Allow or Remove, signed for the person's other Macs where this is the desktop app; Don't allow and Unblock stay here. */
  const act = async (method: "device.allow" | "device.remove", deviceId: string, options: { readonly signed?: boolean; readonly role?: DeviceRequest["role"] } = {}) => {
    setError(null);
    try {
      const own = options.signed ? await thisDevice().catch(() => undefined) : undefined;
      const request = list.requests.find((r) => r.device_id === deviceId);
      const statement = !own ? undefined : method === "device.allow" ? request && (await allowStatement(own, list, request)) : await removeStatement(own, list, deviceId);
      await client.call(method, { request_id: requestId(), device_id: deviceId, ...(options.role ? { role: options.role } : {}), ...(statement ? { statement } : {}) });
      refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };
  const empty = list.devices.length === 0 && list.requests.length === 0 && list.blocked.length === 0;
  return (
    <SettingsCard
      title="Devices"
      description="Phones, browsers and Macs that may control this Mac."
    >
      {empty ? <SettingRow label="No device has asked yet" description="Open Caveman Code on your phone or the web and this Mac asks you here." /> : null}
      {own ? <SettingRow label="This Mac's code" description={ownCodeCopy(deviceCode(own.device_id))} /> : null}
      {own && list.family ? <AddMac client={client} pairing={list.pairing} /> : null}
      {own && list.family ? <JoinMac /> : null}
      {list.requests.map((r) => {
        const known = upgradeOf(list, r) !== undefined;
        return (
          <SettingRow key={r.device_id} label={r.name} description={requestRowCopy(r, known)}>
            <div className="flex gap-2">
              {known ? (
                <Button variant="outline" onClick={() => void act("device.allow", r.device_id, { role: "device" })}>
                  Keep as a device
                </Button>
              ) : (
                <Button variant="outline" onClick={() => void act("device.remove", r.device_id)}>
                  {"Don't allow"}
                </Button>
              )}
              <Button onClick={() => void act("device.allow", r.device_id, { signed: true, role: r.role ?? "device" })}>
                Allow
              </Button>
            </div>
          </SettingRow>
        );
      })}
      {list.devices.map((d) => (
        <SettingRow
          key={d.device_id}
          label={d.name}
          description={`${allowedCopy(d)}.${notSharedCopy(d)} ${d.connected ? "Connected now" : d.last_seen_at ? `Last used ${when(d.last_seen_at)}` : `Allowed ${when(d.added_at)}`}`}
        >
          <Button variant="outline" aria-label={`Remove ${d.name}`} onClick={() => setRemoving(d)}>
            Remove
          </Button>
        </SettingRow>
      ))}
      {removing ? (
        <RemoveDevice
          device={removing}
          shared={!!own && !!list.family}
          onCancel={() => setRemoving(null)}
          onRemove={() => {
            setRemoving(null);
            void act("device.remove", removing.device_id, { signed: true });
          }}
        />
      ) : null}
      {list.blocked.map((b) => (
        <SettingRow key={b.device_id} label={b.name} description={`${removedCopy(b)} ${when(b.at)}.${notSharedCopy(b)} Blocked on this Mac until you unblock it.`}>
          <Button variant="ghost" onClick={() => void act("device.remove", b.device_id)}>
            Unblock
          </Button>
        </SettingRow>
      ))}
      <SettingRow id={id} label="Stay awake while another device uses this Mac" description="On power only. A closed lid still sleeps it.">
        <Switch id={id} disabled={!settings} checked={settings?.keep_awake_remote !== false} onCheckedChange={(on) => void save({ keep_awake_remote: on })} />
      </SettingRow>
      {error ? (
        <p role="alert" className="px-5 py-3 text-[12.5px] text-destructive">
          {error}
        </p>
      ) : null}
    </SettingsCard>
  );
}

/** Remove's confirmation (m-15): Cancel has the focus, so Return never removes a device every Mac then drops. */
function RemoveDevice({ device, shared, onCancel, onRemove }: { device: DeviceList["devices"][number]; shared: boolean; onCancel: () => void; onRemove: () => void }) {
  const copy = removeConfirmCopy(device, shared);
  return (
    <Dialog open onOpenChange={(open) => !open && onCancel()}>
      <DialogContent size="sm">
        <DialogHeader>
          <DialogTitle>{copy.title}</DialogTitle>
          <DialogDescription>{copy.detail}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" autoFocus onClick={onCancel}>
            Cancel
          </Button>
          <Button variant="destructive" onClick={onRemove}>
            Remove
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Add a Mac (decision 31), in the desktop app: a one-time code this Mac shows for ten minutes, which the person types
 * into Caveman Code on their other Mac (Join your other Mac). That Mac then asks here as one of their Macs. The code
 * goes the moment a Mac tries it, right or wrong.
 */
function AddMac({ client, pairing }: { client: Client; pairing: DeviceList["pairing"] }) {
  const [shown, setShown] = useState<{ readonly code: string; readonly expires_at: string } | null>(null);
  /** The list said this code is live: once it no longer does, a Mac tried it (or a newer one replaced it). */
  const [listed, setListed] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (shown && pairing?.expires_at === shown.expires_at) setListed(true);
  }, [shown, pairing]);
  const live = shown && Date.parse(shown.expires_at) > now && (!listed || pairing?.expires_at === shown.expires_at) ? shown : null;
  useEffect(() => {
    if (!live) return;
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [live]);
  const start = async () => {
    setError(null);
    try {
      const next = await client.call("device.pair.start", { request_id: requestId() });
      setListed(false);
      setShown(next);
      setNow(Date.now());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };
  const description = live ? (
    <PairingCode code={live.code} leftMs={Date.parse(live.expires_at) - now} />
  ) : error ? (
    <span role="alert" className="text-destructive">
      {error}
    </span>
  ) : shown ? (
    "That code was used or ran out. Show a new one to add another Mac."
  ) : (
    "Your other Mac joins this one with a one-time code shown here. Then the devices either Mac allows count on both."
  );
  return (
    <SettingRow label="Add a Mac" description={description}>
      {/* Events only (m-14): a code shown, a code gone. The countdown above ticks out of any live region. */}
      <span role="status" aria-live="polite" className="sr-only">
        {pairingAnnouncement(live ? "live" : shown ? "gone" : "none")}
      </span>
      <Button variant="outline" onClick={() => void start()}>
        {live ? "New code" : "Show a code"}
      </Button>
    </SettingRow>
  );
}

/** The code Add a Mac shows, and the time it has left, counted down each second: never in a live region (m-14). */
export function PairingCode({ code, leftMs }: { code: string; leftMs: number }) {
  return (
    <>
      <span className="my-1 block select-all font-mono text-[16px] tracking-[0.14em] text-foreground">{code}</span>
      <span>{pairingCopy(leftMs)}</span>
    </>
  );
}

/**
 * Join your other Mac (decision 31), in the desktop app: the person picks it from their Macs as Caveman lists them and
 * types the code its screen shows (Add a Mac); this Mac's desktop key proves it on a connection of its own, and that
 * Mac's screen asks once whether this Mac is one of theirs.
 */
function JoinMac() {
  const hub = useSyncHub();
  const list = useChatList(hub);
  const targets = joinTargets(list?.runtimes.values() ?? [], hub?.homeRuntimeId());
  const [picked, setPicked] = useState("");
  const [code, setCode] = useState("");
  const [state, setState] = useState<{ readonly kind: "idle" | "joining" | "joined" | "failed"; readonly text?: string }>({ kind: "idle" });
  const id = useId();
  const chosen = targets.find((t) => t.runtime_id === picked) ?? (targets.length === 1 ? targets[0] : undefined);
  const join = () => {
    if (!hub || !chosen) return;
    const mac = chosen.name;
    setState({ kind: "joining", text: `Joining ${mac}…` });
    joinMac((handshake) => hub.connectOnce(chosen.runtime_id, handshake), code, {
      onStatus: (status) => {
        if (status.status === "pending") setState({ kind: "joining", text: `On ${mac}, choose Allow, and check it shows ${status.code}.` });
      },
    }).then(
      () => {
        setCode("");
        setState({ kind: "joined", text: `${mac} took this Mac as one of your Macs.` });
      },
      (e: unknown) => setState({ kind: "failed", text: e instanceof Error ? e.message : String(e) }),
    );
  };
  const description =
    state.kind === "failed" ? (
      <span role="alert" className="text-destructive">
        {state.text}
      </span>
    ) : state.text ? (
      <span aria-live="polite">{state.text}</span>
    ) : targets.length === 0 ? (
      "Your other Macs show here once they are signed in to Caveman with Remote control on."
    ) : (
      "On your other Mac, choose Add a Mac in Settings, Devices, and type the code it shows here."
    );
  return (
    <SettingRow label="Join your other Mac" description={description} {...(targets.length > 0 ? { id } : {})}>
      {targets.length > 0 ? (
        <div className="flex flex-wrap items-center gap-2">
          {targets.length > 1 ? (
            <Select value={chosen?.runtime_id ?? ""} onValueChange={setPicked}>
              <SelectTrigger aria-label="Your other Mac" className={CONTROL}>
                <SelectValue placeholder="Choose a Mac" />
              </SelectTrigger>
              <SelectContent>
                {targets.map((t) => (
                  <SelectItem key={t.runtime_id} value={t.runtime_id}>
                    {t.online ? t.name : `${t.name} (asleep)`}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : null}
          <Input
            id={id}
            aria-label={chosen ? `Code from ${chosen.name}` : "Code from your other Mac"}
            placeholder="XXXX-XXXX-XXXX"
            value={code}
            onChange={(e) => setCode(e.target.value)}
            autoComplete="off"
            spellCheck={false}
            className="w-[160px] font-mono"
          />
          <Button variant="secondary" disabled={!chosen || state.kind === "joining" || normalizePairingCode(code) === undefined} onClick={join}>
            Join
          </Button>
        </div>
      ) : null}
    </SettingRow>
  );
}
