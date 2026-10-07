/** A `fetch` that goes straight to a handler: no socket, the same bytes. */
export function fetchTo(
  handler: (request: Request) => Promise<Response>,
): typeof fetch {
  return (input: RequestInfo | URL, init?: RequestInit) =>
    handler(new Request(input, init));
}
