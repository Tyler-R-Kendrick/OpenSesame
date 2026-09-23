/**
 * The browser's ports (ADR 0133 §2). This is the one place outside the
 * worker entries (`*.worker.ts`) where the core touches browser globals; every other module
 * reaches them through `ports.ts`. Each port reads its global when asked, so
 * a test that stubs `localStorage` or `navigator.credentials` still reaches
 * the stub.
 */
import type {
  AuthenticatorPort,
  BroadcastLike,
  EnvironmentPort,
  PagePort,
  Ports,
  StoragePorts,
} from "../ports.js";

const storage: StoragePorts = {
  get local() {
    return globalThis.localStorage ?? undefined;
  },
  get session() {
    return globalThis.sessionStorage ?? undefined;
  },
};

function startDownload(href: string, fileName: string): void {
  const anchor = document.createElement("a");
  anchor.href = href;
  anchor.download = fileName;
  anchor.rel = "noopener";
  anchor.click();
}

function submitForm(
  action: string,
  fields: Readonly<Record<string, string>>,
  target: string,
): void {
  const form = document.createElement("form");
  form.method = "POST";
  form.action = action;
  form.acceptCharset = "UTF-8";
  form.target = target;
  for (const [name, value] of Object.entries(fields)) {
    const input = document.createElement("input");
    input.type = "hidden";
    input.name = name;
    input.value = value;
    form.appendChild(input);
  }
  document.body.appendChild(form);
  form.submit();
}

/**
 * The window, read at call time. In a tab it is `globalThis`; a test may
 * stand a narrower object in for it, as the code before the ports read
 * `window.*` and bare globals interchangeably.
 */
function win(): Window & typeof globalThis {
  return globalThis.window ?? globalThis;
}

const pagePort: PagePort = {
  get location() {
    return win().location ?? globalThis.location;
  },
  get opener() {
    return win().opener ?? null;
  },
  get isSecureContext() {
    return (win().isSecureContext ?? globalThis.isSecureContext) === true;
  },
  get visibilityState() {
    return globalThis.document?.visibilityState ?? "visible";
  },
  addEventListener: (...args: Parameters<Window["addEventListener"]>) =>
    win().addEventListener(...args),
  removeEventListener: (...args: Parameters<Window["removeEventListener"]>) =>
    win().removeEventListener(...args),
  open: (...args: Parameters<Window["open"]>) => win().open(...args),
  close: () => win().close(),
  replaceUrl: (url) => globalThis.history.replaceState(null, "", url),
  onVisibilityChange(listener) {
    const doc = globalThis.document;
    doc?.addEventListener("visibilitychange", listener);
    return () => doc?.removeEventListener("visibilitychange", listener);
  },
  startDownload,
  submitForm,
};

const authenticator: AuthenticatorPort = {
  get credentials() {
    return globalThis.navigator?.credentials ?? undefined;
  },
  get publicKeyCredential() {
    return globalThis.PublicKeyCredential ?? undefined;
  },
};

const environment: EnvironmentPort = {
  get online() {
    return globalThis.navigator?.onLine ?? true;
  },
  onOnlineChange(listener) {
    const on = () => listener(true);
    const off = () => listener(false);
    win().addEventListener?.("online", on);
    win().addEventListener?.("offline", off);
    return () => {
      win().removeEventListener?.("online", on);
      win().removeEventListener?.("offline", off);
    };
  },
  get userAgent() {
    return globalThis.navigator?.userAgent ?? "";
  },
  get userActivated() {
    return globalThis.navigator?.userActivation?.isActive === true;
  },
  get workers() {
    return {
      dedicated: typeof Worker !== "undefined",
      shared: typeof SharedWorker !== "undefined",
      service:
        typeof navigator !== "undefined" &&
        "serviceWorker" in navigator &&
        navigator.serviceWorker !== undefined,
    };
  },
};

/** Every port a browser tab provides. Read lazily; install with the env. */
export function browserPorts(): Ports {
  return {
    storage,
    /** A page wherever there is a window or an address: a tab, or a test's stub. */
    get page() {
      return globalThis.window === undefined &&
        globalThis.location === undefined
        ? undefined
        : pagePort;
    },
    authenticator,
    get environment() {
      return globalThis.navigator === undefined ? undefined : environment;
    },
    get locks() {
      return globalThis.navigator?.locks ?? undefined;
    },
    get broadcast() {
      return typeof BroadcastChannel === "undefined"
        ? undefined
        : (name: string): BroadcastLike => new BroadcastChannel(name);
    },
    get worker() {
      return typeof Worker === "function" ? Worker : undefined;
    },
    get serviceWorker() {
      return globalThis.navigator?.serviceWorker ?? undefined;
    },
    get originFiles() {
      const storageManager = globalThis.navigator?.storage;
      return storageManager?.getDirectory === undefined
        ? undefined
        : () => storageManager.getDirectory();
    },
    get indexedDB() {
      return globalThis.indexedDB ?? undefined;
    },
  };
}
