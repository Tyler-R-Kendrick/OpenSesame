/** Minimal callback shell — reads the fragment and posts the token to the RP verifier. */
export function siopCallbackHtml(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>SIOP callback</title>
  <style>
    body { font-family: system-ui, sans-serif; margin: 2rem; max-width: 40rem; line-height: 1.5; }
    .err { color: #8b0000; }
  </style>
</head>
<body>
  <p id="status">Verifying Self-Issued response…</p>
  <pre id="detail" hidden></pre>
  <script type="module">
    const status = document.getElementById("status");
    const detail = document.getElementById("detail");
    const params = new URLSearchParams(location.hash.replace(/^#/, ""));
    const idToken = params.get("id_token");
    const state = params.get("state");
    const err = params.get("error");
    if (err) {
      status.textContent = "Sign-in denied or failed.";
      status.className = "err";
      detail.hidden = false;
      detail.textContent = params.get("error_description") ?? err;
      throw new Error(err);
    }
    if (!idToken || !state) {
      status.textContent = "Missing id_token or state in the fragment.";
      status.className = "err";
      throw new Error("missing_fragment");
    }
    const res = await fetch("/api/complete", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id_token: idToken, state }),
    });
    const body = await res.json();
    if (!res.ok) {
      status.textContent = "Verification failed.";
      status.className = "err";
      detail.hidden = false;
      detail.textContent = body.error ?? res.statusText;
      throw new Error("verify_failed");
    }
    status.textContent = "Self-Issued subject verified (JWK thumbprint).";
    detail.hidden = false;
    detail.textContent = JSON.stringify(body.session, null, 2);
  </script>
</body>
</html>`;
}
