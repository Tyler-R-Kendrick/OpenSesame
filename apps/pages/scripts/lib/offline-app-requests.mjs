/** Account only for network fallback attempted while the owned app socket is stopped. */
export function offlineAppRequests(origin, base) {
  const paths = new Set([
    `${base}settings/connections/tailscale`,
    `${base}os-runtime-config.json`,
    `${base}capability-graph.json`,
  ]);
  let startedOffline = new WeakSet();
  let offline = false;
  return {
    begin: () => {
      startedOffline = new WeakSet();
      offline = true;
    },
    end: () => {
      offline = false;
    },
    observe(request) {
      const url = new URL(request.url());
      if (
        offline &&
        request.method() === "GET" &&
        url.origin === origin &&
        !url.username &&
        !url.password &&
        !url.search &&
        !url.hash &&
        paths.has(url.pathname)
      )
        startedOffline.add(request);
    },
    expected(request) {
      return (
        offline &&
        startedOffline.has(request) &&
        request.failure()?.errorText === "net::ERR_CONNECTION_REFUSED"
      );
    },
  };
}
