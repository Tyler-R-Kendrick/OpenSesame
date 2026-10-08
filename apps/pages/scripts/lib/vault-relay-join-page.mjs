/**
 * Join page two browser contexts use to publish or read one relay slot.
 * The snapshot this page publishes has no item name.
 */

export const JOIN_HTML = `<!doctype html>
<meta charset="utf-8">
<title>Relay session</title>
<main>
  <h1>Relay session</h1>
  <label>
    <input type="checkbox" id="consent">
    <span id="consent-label">I consent to publish this vault</span>
  </label>
  <button type="button" id="join" disabled>Join session</button>
  <section id="joined" hidden aria-label="Joined session">
    <p>Create status <span id="create-status"></span></p>
    <p>Generation <span id="generation"></span></p>
    <p>Ciphertext <span id="ct"></span></p>
  </section>
</main>
<script type="module">
const params = new URLSearchParams(location.search);
const owner = params.get("owner") ?? "";
const slug = params.get("slug") ?? "";
const principal = params.get("principal") ?? "";
const ownerKind = params.get("ownerKind") || "organization";
const slotKey = params.get("slotKey") ?? "";
const role = params.get("role") ?? "";
const relay = (params.get("relay") ?? "").replace(/\\/$/, "");
const api = (path) => (relay ? relay + path : path);
const snapshot = {
  format: "opensesame-vault-drive-snapshot",
  v: 1,
  tomb: slug,
  header: { v: 1, createdAt: "2026-10-07T00:00:00Z" },
  body: { ivB64: "aXY", ctB64: "Y2lwaGVydGV4dA" },
  rev: 1,
};
document.getElementById("consent-label").textContent = role === "a"
  ? "I consent to publish this vault"
  : "I consent to join this vault";
const consent = document.getElementById("consent");
const button = document.getElementById("join");
consent.addEventListener("change", () => {
  button.disabled = !consent.checked;
});
const show = (status, generation, ct) => {
  document.getElementById("create-status").textContent = status;
  document.getElementById("generation").textContent = generation;
  document.getElementById("ct").textContent = ct;
  document.getElementById("joined").hidden = false;
};
button.addEventListener("click", async () => {
  if (!consent.checked) return;
  button.disabled = true;
  try {
    const created = await fetch(api("/v1/org-vaults"), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-opensesame-principal": principal,
        "x-opensesame-org-role": role === "a" ? "owner" : "member",
      },
      body: JSON.stringify({ ownerKind, owner, slug }),
    });
    if (role === "a") {
      const put = await fetch(api("/v1/vault-relay/" + owner + "/" + slug + "/snapshot"), {
        method: "PUT",
        headers: {
          "content-type": "application/json",
          "x-opensesame-slot-key": slotKey,
          "x-opensesame-principal": principal,
          "x-opensesame-owner-kind": ownerKind,
          "x-opensesame-org-role": "owner",
        },
        body: JSON.stringify({ expected_generation: 0, snapshot }),
      });
      const body = await put.json();
      show(String(created.status), String(body.generation ?? ""), snapshot.body.ctB64);
      return;
    }
    const got = await fetch(api("/v1/vault-relay/" + owner + "/" + slug + "/snapshot"), {
      headers: { "x-opensesame-slot-key": slotKey },
    });
    const body = await got.json();
    const ct = body && body.snapshot && body.snapshot.body ? body.snapshot.body.ctB64 : "";
    show(String(created.status), String(body.generation ?? ""), ct ?? "");
  } catch (error) {
    show("error", "", String(error));
  }
});
</script>
`;
