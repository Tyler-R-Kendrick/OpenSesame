/** Bounded same-origin transport and WebAuthn encoding shared by hosted ceremonies. */
export const ceremonyClientScript = `const read = async (response) => {
  if (!response.ok || !response.body) throw new Error("refused");
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8",{fatal:true});
  let text = "", size = 0;
  const abort = () => { void reader.cancel(); };
  lifetime.signal.addEventListener("abort",abort,{once:true});
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > 20000) throw new Error("refused");
      text += decoder.decode(part.value,{stream:true});
    }
    if (lifetime.signal.aborted) throw new Error("refused");
    return JSON.parse(text + decoder.decode());
  } finally {
    lifetime.signal.removeEventListener("abort",abort);
    await reader.cancel();
  }
};
const post = (path,payload) => fetch(path,{
  method:"POST",credentials:"same-origin",redirect:"error",cache:"no-store",
  headers:{"content-type":"application/json"},body:JSON.stringify(payload),
  signal:AbortSignal.any([lifetime.signal,AbortSignal.timeout(10000)])
}).then(read);
const bytes = (value) => Uint8Array.from(atob(value.replace(/-/g,"+").replace(/_/g,"/")), c => c.charCodeAt(0));
const encoded = (value) => btoa(String.fromCharCode(...new Uint8Array(value))).replace(/=/g,"").replace(/\\+/g,"-").replace(/\\//g,"_");
`;
