// Enough of Electron's main-process API to run src/main.ts under vitest, which has no Electron: test/main.test.ts.
// What a test drives or reads (the app's events, its windows and their pages, IPC, menus, the global shortcut, the
// Dock badge) behaves as Electron 44 does; everything else main.ts touches is a stub that accepts any call.
import { EventEmitter } from "node:events";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Callable, constructible and chainable to any depth, and never a thenable, so `await` on it does not hang. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const stub = (): any => {
  const props = new Map<PropertyKey, unknown>();
  return new Proxy(function () {}, {
    get(_target, prop) {
      if (prop === "then") return undefined;
      if (prop === Symbol.toPrimitive) return () => "";
      if (prop === Symbol.iterator) return function* () {};
      if (!props.has(prop)) props.set(prop, stub());
      return props.get(prop);
    },
    set(_target, prop, value) {
      props.set(prop, value);
      return true;
    },
    apply: () => stub(),
    construct: () => stub(),
  });
};

/** `target`, with a stub for whatever it does not define. */
const stubbed = <T extends object>(target: T): T =>
  new Proxy(target, {
    get(t, prop, receiver) {
      if (prop in t || typeof prop === "symbol" || prop === "then")
        return Reflect.get(t, prop, receiver);
      const s = stub();
      Reflect.set(t, prop, s);
      return s;
    },
  });

const userData = mkdtempSync(join(tmpdir(), "caveman-desktop-main-"));

let resolveReady!: () => void;
const ready = new Promise<void>((done) => (resolveReady = done));

class FakeApp extends EventEmitter {
  readonly isPackaged = false;
  readonly name = "Caveman Code";
  readonly commandLine = { hasSwitch: () => true, appendSwitch: () => undefined };
  readonly dock = undefined;
  badge = 0;
  quits = 0;
  getPath = (name: string) => join(userData, name);
  setPath = () => undefined;
  getVersion = () => "0.0.0-test";
  /** Ready once the test says so (`fake.ready()`): what main.ts does before `ready` comes first. */
  whenReady = () => ready;
  isReady = () => false;
  requestSingleInstanceLock = () => true;
  isInApplicationsFolder = () => false;
  setAsDefaultProtocolClient = () => true;
  setAppUserModelId = () => undefined;
  setBadgeCount = (count: number) => {
    this.badge = count;
    return true;
  };
  getBadgeCount = () => this.badge;
  quit = () => void (this.quits += 1);
  exit = () => undefined;
}
const app = stubbed(new FakeApp());

let focused: FakeWindow | null = null;
const windows: FakeWindow[] = [];

/** A page. A load runs until the test ends it with `finishLoad()`; `framesLoading` is a subframe (an iframe) loading. */
class FakeWebContents extends EventEmitter {
  private static ids = 0;
  readonly id = ++FakeWebContents.ids;
  url = "";
  mainFrameLoading = false;
  framesLoading = false;
  readonly scripts: string[] = [];
  /** Electron's: true while any frame of the page loads, an iframe included. */
  isLoading() {
    return this.mainFrameLoading || this.framesLoading;
  }
  isLoadingMainFrame() {
    return this.mainFrameLoading;
  }
  isDestroyed() {
    return false;
  }
  getURL() {
    return this.url;
  }
  getType() {
    return "window";
  }
  executeJavaScript(code: string) {
    this.scripts.push(code);
    return Promise.resolve();
  }
  send() {}
  setWindowOpenHandler() {}
  reload() {
    void this.load(this.url);
  }
  load(url: string): Promise<void> {
    this.url = url;
    this.mainFrameLoading = true;
    return Promise.resolve();
  }
  /** As Electron 44 ends a load: did-finish-load while isLoadingMainFrame() still says true, then did-stop-loading. */
  finishLoad(): void {
    this.emit("did-finish-load");
    this.mainFrameLoading = false;
    this.emit("did-stop-loading");
  }
}

// Methods, not arrow fields: `this` is the stubbed proxy main.ts holds, so the window an event names is the one it has.
class FakeWindow extends EventEmitter {
  readonly webContents = stubbed(new FakeWebContents());
  readonly options: Record<string, unknown>;
  visible = false;
  destroyed = false;
  constructor(options: Record<string, unknown> = {}) {
    super();
    this.options = options;
    const window = stubbed(this);
    windows.push(window);
    // eslint-disable-next-line no-constructor-return -- the stub stands in for the window Electron hands back.
    return window;
  }
  isDestroyed() {
    return this.destroyed;
  }
  isMinimized() {
    return false;
  }
  isMaximized() {
    return false;
  }
  isFullScreen() {
    return false;
  }
  isVisible() {
    return this.visible;
  }
  isFocused() {
    return focused === this;
  }
  getBounds() {
    return { x: 0, y: 0, width: 1200, height: 800 };
  }
  loadURL(url: string) {
    return this.webContents.load(url);
  }
  show() {
    this.visible = true;
  }
  /** Taking focus emits the app's browser-window-focus, for any window: a panel's too. */
  focus() {
    if (focused === this || !this.visible) return;
    focused = this;
    app.emit("browser-window-focus", {}, this);
  }
  hide() {
    this.visible = false;
    if (focused === this) focused = null;
  }
  destroy() {
    this.hide();
    this.destroyed = true;
    this.emit("closed");
  }
  static getFocusedWindow() {
    return focused;
  }
  static getAllWindows() {
    return windows.filter((w) => !w.destroyed);
  }
  static fromWebContents(contents: unknown) {
    return windows.find((w) => w.webContents === contents) ?? null;
  }
}

type Listener = (event: unknown, ...args: unknown[]) => unknown;
const ipcListeners = new Map<string, Listener>();
const ipcHandlers = new Map<string, Listener>();
const ipcMain = stubbed({
  on: (channel: string, listener: Listener) => void ipcListeners.set(channel, listener),
  handle: (channel: string, handler: Listener) => void ipcHandlers.set(channel, handler),
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- menu templates take any of Electron's item fields.
type Template = Array<Record<string, any>>;
let appMenu: Template = [];
const Menu = stubbed({
  buildFromTemplate: (template: Template) => stubbed({ template }),
  setApplicationMenu: (menu: { template: Template } | null) =>
    void (appMenu = menu?.template ?? []),
});

const shortcuts = new Map<string, () => void>();
const globalShortcut = stubbed({
  register: (accelerator: string, callback: () => void) => {
    shortcuts.set(accelerator, callback);
    return true;
  },
  unregister: (accelerator: string) => void shortcuts.delete(accelerator),
  unregisterAll: () => shortcuts.clear(),
  isRegistered: (accelerator: string) => shortcuts.has(accelerator),
});

const display = {
  bounds: { x: 0, y: 0, width: 1440, height: 900 },
  workArea: { x: 0, y: 0, width: 1440, height: 900 },
};
const screen = stubbed({
  getAllDisplays: () => [display],
  getPrimaryDisplay: () => display,
  getDisplayMatching: () => display,
  getDisplayNearestPoint: () => display,
  getCursorScreenPoint: () => ({ x: 0, y: 0 }),
});

interface Question {
  readonly message: string;
  readonly detail?: string;
  readonly buttons?: ReadonlyArray<string>;
}
const questions: Question[] = [];

const powerMonitor = stubbed(Object.assign(new EventEmitter(), { isOnBatteryPower: () => false }));

export const electron = {
  app,
  BrowserWindow: FakeWindow,
  ipcMain,
  Menu,
  globalShortcut,
  screen,
  powerMonitor,
  nativeTheme: stubbed(
    Object.assign(new EventEmitter(), { shouldUseDarkColors: true, themeSource: "system" }),
  ),
  safeStorage: stubbed({
    isEncryptionAvailable: () => true,
    encryptString: (text: string) => Buffer.from(text),
    decryptString: (sealed: Buffer) => sealed.toString(),
  }),
  dialog: stubbed({
    // (options) or (window, options); every one is answered with its first button.
    showMessageBox: async (...args: unknown[]) => {
      questions.push(args.at(-1) as Question);
      return { response: 0, checkboxChecked: false };
    },
    showErrorBox: () => undefined,
  }),
  powerSaveBlocker: stubbed({ start: () => 1, stop: () => undefined, isStarted: () => false }),
  nativeImage: stubbed({ createFromPath: () => ({ isEmpty: () => true }) }),
  autoUpdater: new EventEmitter(),
  clipboard: stub(),
  crashReporter: stub(),
  desktopCapturer: stub(),
  protocol: stub(),
  session: stub(),
  shell: stub(),
  systemPreferences: stub(),
  ShareMenu: stub(),
};

const findItem = (items: Template, label: string): Record<string, unknown> | undefined => {
  for (const item of items) {
    if (item.label === label) return item;
    const inner = Array.isArray(item.submenu) ? findItem(item.submenu, label) : undefined;
    if (inner) return inner;
  }
  return undefined;
};

/** What a test drives and reads. */
export const fake = {
  app,
  powerMonitor,
  windows,
  /** The message boxes main.ts showed. */
  questions,
  /** Electron's `ready`. */
  ready: () => resolveReady(),
  /** The page's IPC from our own frame: `ipcRenderer.send` or `invoke`. */
  ipc: (channel: string, ...args: unknown[]) => {
    const listener = ipcListeners.get(channel) ?? ipcHandlers.get(channel);
    if (!listener) throw new Error(`main.ts has no IPC on ${channel}`);
    const event: { senderFrame: { url: string }; sender: unknown; returnValue?: unknown } = {
      senderFrame: { url: "caveman-code://app/" },
      sender: windows[0]?.webContents,
    };
    const result = listener(event, ...args);
    return event.returnValue ?? result;
  },
  /** The application menu's item, clicked. */
  clickMenu: (label: string) => {
    const item = findItem(appMenu, label);
    if (typeof item?.click !== "function") throw new Error(`no menu item ${label}`);
    item.click(item, focused ?? undefined, {});
  },
  shortcut: (accelerator: string) => shortcuts.get(accelerator),
};
