/**
 * The three small assets the relying party serves: the index, the callback
 * page, and the script that carries the fragment to the server.
 *
 * The id_token returns in the URL *fragment* (`response_mode=fragment`), which
 * a server never sees. So a page reads it, removes it from the address bar and
 * history at once, and posts it back to the route it was served from. Scripts
 * and styles are separate files so the page can run under a CSP with no inline
 * code at all.
 */

const SHELL_HEAD = `<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<link rel="stylesheet" href="/example.css" />`;

export function indexHtml(input: {
  pagesBase: string;
  clientId: string;
  redirectUri: string;
}): string {
  return `<!doctype html>
<html lang="en">
<head>
${SHELL_HEAD}
<title>SIOPv2 relying party</title>
</head>
<body>
<h1>SIOPv2 relying party</h1>
<form action="/auth/start" method="get">
<label for="client_id">Your OpenSesame application id</label>
<input id="client_id" name="client_id" placeholder="local_00000000-0000-4000-8000-000000000000" pattern="local_[0-9a-f\\-]{36}" size="44" />
<button id="signin-form" type="submit">Sign in with OpenSesame Pages</button>
</form>
<p><a id="signin" href="/auth/start">Sign in as the configured application</a></p>
<dl>
<dt>Pages</dt><dd><code>${input.pagesBase}</code></dd>
<dt>client_id</dt><dd><code>${input.clientId}</code></dd>
<dt>redirect_uri</dt><dd><code>${input.redirectUri}</code></dd>
</dl>
</body>
</html>`;
}

export function callbackHtml(): string {
  return `<!doctype html>
<html lang="en">
<head>
${SHELL_HEAD}
<title>Signing in</title>
</head>
<body>
<p id="status" role="status" data-state="working">Verifying the response</p>
<pre id="detail" hidden></pre>
<script src="/siop-callback.js"></script>
</body>
</html>`;
}

/** Served as `/siop-callback.js`; posts to the route that served the page. */
export const CALLBACK_SCRIPT = `const status = document.getElementById("status");
const detail = document.getElementById("detail");
const response = location.hash;
// The token is a credential until it is verified: take it out of the address
// bar and the history entry before anything else can read it.
history.replaceState(null, "", location.pathname + location.search);

function show(state, text, extra) {
  status.dataset.state = state;
  status.textContent = text;
  if (extra) {
    detail.hidden = false;
    detail.textContent = extra;
  }
}

if (response.length <= 1) {
  show("refused", "No response in the address.");
} else {
  // The route that answers is the route that was asked: path and query.
  fetch(location.pathname + location.search, {
    method: "POST",
    credentials: "same-origin",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ response }),
  })
    .then(async (result) => {
      const body = await result.json();
      if (!result.ok) {
        status.dataset.code = body.error;
        return show("refused", "Sign-in was refused.", body.error);
      }
      show("verified", "Signed in.", JSON.stringify(body.session, null, 2));
    })
    .catch(() => show("refused", "The server could not be reached."));
}
`;

export const EXAMPLE_CSS = `body { font-family: system-ui, sans-serif; margin: 2rem auto; max-width: 40rem; line-height: 1.5; padding: 0 1rem; }
code, pre { font-size: 0.9em; overflow-wrap: anywhere; white-space: pre-wrap; }
[data-state="refused"] { color: #8b0000; }
`;
