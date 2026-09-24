const issuerInput = document.querySelector<HTMLInputElement>("#issuer");
const out = document.querySelector<HTMLPreElement>("#out");
const button = document.querySelector<HTMLButtonElement>("#register");

button?.addEventListener("click", async () => {
  const issuer = (issuerInput?.value ?? "").replace(/\/+$/u, "");
  if (out) out.textContent = "registering…";
  const res = await fetch(`${issuer}/agent/identity`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ type: "anonymous" }),
  });
  const body = await res.json();
  if (out) out.textContent = JSON.stringify(body, null, 2);
});
