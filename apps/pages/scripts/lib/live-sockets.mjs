/**
 * Whether a page has let go of its sockets to a server (ADR 0150 §6).
 *
 * A session's owner keeps one WebSocket to each carrier for as long as the
 * session lasts, and closes it when the session ends. The close is a
 * handshake, not an instant: the page sends a close frame and waits for the
 * server's. A walk that stops the server under it before the handshake is
 * done makes the engine report a reset (WebKit does, as a console error, and
 * this walk fails on a console error). So the walk waits for the page to be
 * done with a server before it stops that server.
 */

/** The sockets in `sockets` that are open and name `host`. */
export function openTo(sockets, host) {
  return sockets.filter(
    (socket) => !socket.isClosed() && socket.url().includes(host),
  );
}

/**
 * Resolves with the urls still open to `host`: none once the page has let go
 * of them, or whatever is left after `ms` (a page that never lets go is for
 * the caller to say; a wait never hangs the walk).
 */
export async function released(sockets, host, ms = 5000) {
  const until = Date.now() + ms;
  while (openTo(sockets, host).length > 0 && Date.now() < until)
    await new Promise((resolve) => setTimeout(resolve, 25));
  return openTo(sockets, host).map((socket) => socket.url());
}

/**
 * The walk's wait before it stops a carrier: the owner page has let go of its
 * sockets to that carrier's address. A carrier the page reaches without a
 * socket (broadcast has no address, ntfy is fetch) has nothing to wait for.
 */
export async function ownerReleases(owner, server) {
  if (!server.url) return [];
  return owner.released(new URL(server.url).host);
}
