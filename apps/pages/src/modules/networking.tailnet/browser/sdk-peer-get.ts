import type { NativeRequest, NativeResponse } from "./protocol.js";

type PeerToken = Readonly<{ id: number }>;

type Owner = { generation: object; signal: AbortSignal; current(): boolean };
type RawPort = {
  begin(
    id: number,
    request: NativeRequest,
    token: PeerToken,
    publish: (
      token: PeerToken,
      id: number,
      response: NativeResponse | null,
      code: string,
    ) => boolean,
  ): string;
  current(id: number): boolean;
  cancel(id: number): boolean;
  close(): void;
  drain(
    token: PeerToken,
    publish: (
      token: PeerToken,
      id: number,
      value: null,
      code: string,
    ) => boolean,
  ): string;
};
export type NativePeerGETClient = {
  ready(): boolean;
  nativeHTTP(
    id: number,
    request: NativeRequest,
    signal: AbortSignal,
  ): Promise<NativeResponse>;
  cancelHTTP(id: number): boolean;
  close(): Promise<boolean>;
};
export type NativePeerGETNode = {
  nativePeerGETPort?: RawPort;
  nativePeerGETReady?: () => boolean;
};
type Binding = {
  nativeHTTP(
    id: number,
    request: NativeRequest,
    owner: Owner,
  ): Promise<NativeResponse>;
  cancelHTTP(id: number): boolean;
  closeHTTP(): boolean;
};
type Bridge = {
  bindNativeHTTP(
    raw: Pick<RawPort, "begin" | "current" | "cancel" | "close">,
    owner: Owner,
  ): Binding;
};

/** Bind original node methods/receiver before importing the owned bridge. */
export async function bindNativePeerGET(
  node: NativePeerGETNode,
  asset: string,
): Promise<NativePeerGETClient> {
  const raw = node.nativePeerGETPort;
  const ready = node.nativePeerGETReady;
  if (!raw || !ready || !raw.drain)
    throw new Error("This native build has no peer GET contract.");
  const drain = raw.drain.bind(raw);
  const originalRaw = Object.freeze({
    begin: raw.begin.bind(raw),
    current: raw.current.bind(raw),
    cancel: raw.cancel.bind(raw),
    close: raw.close.bind(raw),
  });
  const originalReady = ready.bind(node);
  const owner = new AbortController();
  const generation = Object.freeze({});
  let closed = false;
  let high = 0;
  let retiring: Promise<boolean> | null = null;
  const current = () => !closed && !owner.signal.aborted && originalReady();
  const module: Bridge = await import(/* @vite-ignore */ asset);
  const binding = module.bindNativeHTTP(originalRaw, {
    generation,
    signal: owner.signal,
    current,
  });
  const client: NativePeerGETClient = {
    ready: current,
    nativeHTTP(id, request, signal) {
      if (!Number.isSafeInteger(id) || id < 1 || id <= high)
        return Promise.reject(new Error("Consumed original peer GET id."));
      high = id;
      if (
        closed ||
        signal.aborted ||
        request.method !== "GET" ||
        request.headers.length ||
        request.body.byteLength ||
        !["http:", "https:"].includes(new URL(request.url).protocol)
      )
        return Promise.reject(new Error("Invalid original peer GET."));
      return binding.nativeHTTP(id, request, {
        generation,
        signal,
        current: () => current() && !signal.aborted,
      });
    },
    cancelHTTP(id) {
      if (Number.isSafeInteger(id) && id > high) high = id;
      return binding.cancelHTTP(id);
    },
    close() {
      if (retiring) return retiring;
      closed = true;
      const withdrawn = binding.closeHTTP();
      owner.abort();
      retiring = new Promise<boolean>((resolve) => {
        const token = Object.freeze({ id: 0 });
        let settled = false;
        const finish = (value: boolean) => {
          if (!settled) {
            settled = true;
            resolve(value);
          }
        };
        try {
          const code = drain(token, (received, id, value, error) => {
            if (received !== token || id !== 0 || value !== null) return false;
            finish(withdrawn && error === "");
            return true;
          });
          if (code !== "") finish(false);
        } catch {
          finish(false);
        }
      });
      return retiring;
    },
  };
  return Object.freeze(client);
}
