export function isOnline(): boolean {
  return typeof navigator === "undefined" ? true : navigator.onLine;
}

export function subscribeConnectivity(
  cb: (online: boolean) => void,
): () => void {
  const on = () => cb(true);
  const off = () => cb(false);
  window.addEventListener("online", on);
  window.addEventListener("offline", off);
  return () => {
    window.removeEventListener("online", on);
    window.removeEventListener("offline", off);
  };
}
