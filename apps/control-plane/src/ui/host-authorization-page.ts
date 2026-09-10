import { ceremonyClientScript } from "./ceremony-client-script.js";

/** Runs only on the Identity origin: an RP cannot use another origin's passkeys. */
export const hostAuthorizationScript = `"use strict";
const params = new URL(location.href).searchParams;
const origin = params.get("origin");
const state = params.get("state");
const peer = window.opener;
const message = document.getElementById("message");
const facts = document.getElementById("facts");
const approve = document.getElementById("approve");
const cancel = document.getElementById("cancel");
let pending = null;
let consumed = false;
const lifetime = new AbortController();
const finish = (result) => {
  if (consumed) return;
  consumed = true;
  lifetime.abort();
  approve.disabled = true;
  peer.postMessage({type:"opensesame:host-authorization",state,...result},origin);
};
const fail = () => {
  message.textContent = "Authorization was refused or expired. Return to the requesting window and try again.";
  finish({error:"authorization_refused"});
};
${ceremonyClientScript}
window.addEventListener("message",async (event) => {
  if (event.source !== peer || event.origin !== origin || consumed || pending) return;
  const data = event.data;
  if (!data || data.type !== "opensesame:host-challenge" || data.state !== state) return;
  pending = true;
  try {
    if (JSON.stringify(data).length > 16000 || data.challenge.origin !== origin) throw new Error("refused");
    const result = await post("options",data.challenge);
    if (consumed) return;
    pending = result;
    for (const [label,value] of [
      ["Host",result.challenge.host_audience], ["Requesting origin",origin],
      ["Operation",result.challenge.operation], ["Transition",result.challenge.transition || "Authenticate browser"],
      ["Target",result.challenge.target_id], ["Organization",result.challenge.organization_id],
      ["Expires",new Date(result.challenge.expires_at * 1000).toISOString()]
    ]) {
      const term=document.createElement("dt"), detail=document.createElement("dd");
      term.textContent=label; detail.textContent=value; detail.className="origin"; facts.append(term,detail);
    }
    message.textContent="Check the request, then verify with your Identity passkey. This approval cannot authorize another operation.";
    approve.disabled=false;
  } catch { fail(); }
});
approve.addEventListener("click",async () => {
  if (consumed || !pending || pending === true || approve.disabled) return;
  approve.disabled=true;
  try {
    const options=pending.options;
    const credential=await navigator.credentials.get({
      publicKey:{...options,challenge:bytes(options.challenge),userVerification:"required",
        allowCredentials:options.allowCredentials?.map(item=>({...item,id:bytes(item.id)}))},
      signal:lifetime.signal
    });
    if (!credential || consumed) throw new Error("refused");
    const response=credential.response;
    const result=await post("verify",{
      authorization_id:pending.authorization_id,credentialId:credential.id,
      clientDataJSON:encoded(response.clientDataJSON),authenticatorData:encoded(response.authenticatorData),
      signature:encoded(response.signature)
    });
    if (typeof result.assertion !== "string" || result.assertion.length > 16000) throw new Error("refused");
    finish({assertion:result.assertion});
    message.textContent="Verified. Return to the requesting window.";
  } catch { fail(); }
});
cancel.addEventListener("click",()=>{finish({error:"cancelled"});window.close();});
setTimeout(fail,300000);
if (peer) peer.postMessage({type:"opensesame:host-authorization-ready",state},origin);
else { approve.disabled=true; message.textContent="Open this ceremony from your paired browser."; }
`;

export const hostAuthorizationPage = `<!doctype html><html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Verify Host authorization · OpenSesame Identity</title>
<link rel="stylesheet" href="ceremony.css">
</head><body><main><h1>Verify Host authorization</h1>
<p id="message" role="status">Waiting for the requesting window…</p><dl id="facts"></dl>
<button id="approve" class="btn-primary" type="button" disabled>Verify with passkey</button>
<button id="cancel" type="button">Cancel</button></main>
<script src="ceremony.js"></script></body></html>`;
