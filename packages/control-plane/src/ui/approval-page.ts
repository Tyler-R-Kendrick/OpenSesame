import { ceremonyClientScript } from "./ceremony-client-script.js";

/** No assertion leaves this origin. The requesting portal reads the decision from Identity. */
export const approvalScript = `"use strict";
const params = new URL(location.href).searchParams;
const id = params.get("request"), digest = params.get("digest"), decision = params.get("decision");
const message = document.getElementById("message"), facts = document.getElementById("facts");
const approve = document.getElementById("approve"), cancel = document.getElementById("cancel");
const comparison = document.getElementById("comparison"), code = document.getElementById("code");
const lifetime = new AbortController();
let pending = null, consumed = false;
${ceremonyClientScript}
const root = "/v1/authorization-requests/" + encodeURIComponent(id);
const get = (path) => fetch(path, {credentials:"same-origin", redirect:"error", cache:"no-store",
  signal:AbortSignal.any([lifetime.signal,AbortSignal.timeout(10000)])}).then(read);
const fail = () => {
  consumed = true; lifetime.abort(); approve.disabled = true; code.value = "";
  message.textContent = "Approval unavailable. Check that you are signed in to this Identity service as the approver, with an enrolled passkey. Return to Access and reload the request.";
};
async function load() {
  try {
    if (!id || !digest || !["approve","deny"].includes(decision)) throw new Error("refused");
    const request = await get(root), requirement = await get(root + "/requirement");
    if (request.authReqId !== id || request.requestDigest !== digest || request.status !== "pending" ||
        Date.parse(request.expiresAt) <= Date.now()) throw new Error("refused");
    pending = requirement;
    facts.textContent = JSON.stringify({request:request.bindingMessage, requester:request.requesterRef,
      details:request.authorizationDetails, digest:request.requestDigest, decision, expires:request.expiresAt},null,2);
    comparison.hidden = !requirement.requireComparison;
    approve.textContent = decision === "approve" ? "Verify and approve" : "Verify and deny";
    message.textContent = "Review this exact request and decision. Verification authorizes nothing else.";
    approve.disabled = false;
  } catch { fail(); }
}
approve.addEventListener("click",async () => {
  if (consumed || !pending || approve.disabled) return;
  if (pending.requireComparison && !/^[0-9]{6}$/.test(code.value)) {
    message.textContent = "Enter the six-digit comparison code from the requester."; return;
  }
  approve.disabled = true;
  try {
    const requirement = await get(root + "/requirement");
    if (requirement.policyDigest !== pending.policyDigest) throw new Error("refused");
    let activationId;
    if (requirement.requireTransactionBoundActivation) {
      const challenge = await post(root + "/activation",{requestDigest:digest,
        decision:decision === "approve" ? "approved" : "denied"});
      if (challenge.policyDigest !== requirement.policyDigest) throw new Error("refused");
      const options = challenge.options;
      const credential = await navigator.credentials.get({publicKey:{...options,
        challenge:bytes(options.challenge),userVerification:"required",
        allowCredentials:options.allowCredentials?.map(item=>({...item,id:bytes(item.id)}))},signal:lifetime.signal});
      if (!credential || consumed) throw new Error("refused");
      const response = credential.response;
      await post(root + "/activation/complete",{activationId:challenge.activationId,credentialId:credential.id,
        clientDataJSON:encoded(response.clientDataJSON),authenticatorData:encoded(response.authenticatorData),
        signature:encoded(response.signature)});
      activationId = challenge.activationId;
    }
    lifetime.signal.throwIfAborted();
    const result = await post(root + "/" + decision,{requestDigest:digest,activationId,
      comparisonValue:requirement.requireComparison ? code.value : undefined});
    if (result.requestDigest !== digest || result.status !== (decision === "approve" ? "approved" : "denied")) throw new Error("refused");
    consumed = true; code.value = ""; lifetime.abort();
    message.textContent = "Decision recorded. Return to Access.";
  } catch { fail(); }
});
cancel.addEventListener("click",()=>{consumed=true;lifetime.abort();code.value="";window.close();});
window.addEventListener("pagehide",()=>lifetime.abort(),{once:true});
setTimeout(()=>{if (!consumed) fail();},300000);
void load();
`;

export const approvalPage = `<!doctype html><html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Review access request · OpenSesame Identity</title><link rel="stylesheet" href="ceremony.css">
</head><body><main><h1>Review access request</h1>
<p id="message" role="status">Loading your request…</p><pre id="facts"></pre>
<div id="comparison" class="field" hidden><label for="code">Comparison code from requester</label>
<input id="code" inputmode="numeric" maxlength="6" autocomplete="off"></div>
<button id="approve" class="btn-primary" type="button" disabled>Verify decision</button>
<button id="cancel" type="button">Close</button></main>
<script src="ceremony.js"></script></body></html>`;
