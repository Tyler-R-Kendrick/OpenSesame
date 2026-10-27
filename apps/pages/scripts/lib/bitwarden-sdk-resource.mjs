/** Names minted by shared-worker-graph and bitwarden-worker-assets, inside this app only. */
export function isBitwardenSdkResource(
  input,
  origin,
  base = process.env.VITE_BASE ?? "/OpenSesame/",
) {
  const url = new URL(input);
  if (
    url.origin !== origin ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !url.pathname.startsWith(`${base}assets/`)
  )
    return false;
  const file = url.pathname.slice(`${base}assets/`.length);
  return /^(?:bitwarden-(?:secrets|native)\.worker-[A-Za-z0-9_-]+\.js|bitwarden_wasm_bg\.wasm-[A-Za-z0-9_-]+\.gz|native-worker-bitwarden-(?:worker-protocol|native-worker-protocol|native-contract|native-network-protocol)-[a-f0-9]{8}-[A-Za-z0-9_-]+\.js)$/.test(
    file,
  );
}

export function observeBitwardenSdkResources(context, origin, record) {
  context.on("request", (request) => {
    const url = new URL(request.url());
    if (isBitwardenSdkResource(url, origin))
      record("bws-sdk-resource", url.pathname);
  });
  context.on("requestfailed", (request) => {
    if (isBitwardenSdkResource(request.url(), origin))
      record(
        "worker-network-error",
        `${request.failure()?.errorText}: ${request.url()}`,
      );
  });
}
