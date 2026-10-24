/** Reload once when a newer service worker takes control of this window. */
type ReloadHost = {
  serviceWorker?: Pick<
    ServiceWorkerContainer,
    "controller" | "addEventListener" | "removeEventListener"
  >;
  visibilityState?: DocumentVisibilityState;
  addEventListener?: Window["addEventListener"];
  removeEventListener?: Window["removeEventListener"];
  reload?: () => void;
};

export const pwaRefreshSeams = {
  host: (): ReloadHost => globalThis as ReloadHost,
};

export function installPwaRefresh(check: () => Promise<unknown>): () => void {
  const host = pwaRefreshSeams.host();
  const worker = host.serviceWorker;
  if (!worker || !host.addEventListener) return () => undefined;
  const controlled = Boolean(worker.controller);
  let reloading = false;
  const onController = () => {
    if (!controlled || reloading) return;
    reloading = true;
    (host.reload ?? (() => globalThis.location.reload()))();
  };
  const onVisible = () => {
    if (host.visibilityState === "visible") void check();
  };
  worker.addEventListener("controllerchange", onController);
  host.addEventListener("visibilitychange", onVisible);
  void check();
  return () => {
    worker.removeEventListener?.("controllerchange", onController);
    host.removeEventListener?.("visibilitychange", onVisible);
  };
}
