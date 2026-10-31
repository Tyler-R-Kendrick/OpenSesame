import { asBufferSource } from "@opensesame/os-domain";
/**
 * A DER reader written apart from the encoder it checks: enough of PKCS#10 to
 * pull out the subject, the key, the subjectAltName names and the signature,
 * and to verify that signature the way a CA does.
 */

type Tlv = { tag: number; value: Uint8Array; next: number };

export function tlv(bytes: Uint8Array, offset: number): Tlv {
  const tag = bytes[offset] ?? 0;
  let length = bytes[offset + 1] ?? 0;
  let start = offset + 2;
  if (length & 0x80) {
    const count = length & 0x7f;
    length = 0;
    for (let index = 0; index < count; index += 1)
      length = length * 256 + (bytes[start + index] ?? 0);
    start += count;
  }
  if (start + length > bytes.length) throw new Error("DER overruns its input");
  return {
    tag,
    value: bytes.slice(start, start + length),
    next: start + length,
  };
}

function children(bytes: Uint8Array): Tlv[] {
  const out: Tlv[] = [];
  for (let offset = 0; offset < bytes.length; ) {
    const item = tlv(bytes, offset);
    out.push(item);
    offset = item.next;
  }
  return out;
}

export type ParsedCsr = {
  info: Uint8Array;
  subjectBytes: number;
  spki: Uint8Array;
  names: string[];
  signatureDer: Uint8Array;
  algorithm: number[];
};

/** The dNSName entries of the subjectAltName extension inside the request's attributes. */
function subjectAltNames(attributes: Uint8Array): string[] {
  const names: string[] = [];
  for (const attribute of children(attributes)) {
    const [, values] = children(attribute.value);
    const extensions = values && children(values.value)[0];
    for (const extension of extensions ? children(extensions.value) : []) {
      const [, wrapped] = children(extension.value);
      const list = wrapped && children(wrapped.value)[0];
      for (const name of list ? children(list.value) : [])
        names.push(new TextDecoder().decode(name.value));
    }
  }
  return names;
}

export function parseCsr(der: Uint8Array): ParsedCsr {
  const outer = tlv(der, 0);
  if (outer.tag !== 0x30 || outer.next !== der.length)
    throw new Error("A CSR is one SEQUENCE");
  const [info, algorithm, signature] = children(outer.value);
  if (!info || !algorithm || !signature) throw new Error("CSR parts missing");
  const [version, subject, key, attributes] = children(info.value);
  if (!version || !subject || !key || !attributes || version.tag !== 0x02)
    throw new Error("CertificationRequestInfo parts missing");
  return {
    info: outer.value.slice(0, info.next),
    subjectBytes: subject.value.length,
    spki: info.value.slice(subject.next, key.next),
    names: subjectAltNames(attributes.value),
    signatureDer: signature.value.slice(1),
    algorithm: [...(children(algorithm.value)[0]?.value ?? [])],
  };
}

function integer(bytes: Uint8Array): Uint8Array {
  let start = 0;
  while (start < bytes.length - 1 && bytes[start] === 0) start += 1;
  const padded = new Uint8Array(32);
  const trimmed = bytes.slice(start);
  padded.set(trimmed, 32 - trimmed.length);
  return padded;
}

export function derToP1363(signature: Uint8Array): Uint8Array {
  const [r, s] = children(tlv(signature, 0).value);
  if (!r || !s) throw new Error("ECDSA signature needs r and s");
  const out = new Uint8Array(64);
  out.set(integer(r.value), 0);
  out.set(integer(s.value), 32);
  return out;
}

/** Whether the CSR's signature holds under the public key inside it. */
export async function csrSignatureHolds(csr: ParsedCsr): Promise<boolean> {
  const key = await crypto.subtle.importKey(
    "spki",
    asBufferSource(csr.spki),
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["verify"],
  );
  return crypto.subtle.verify(
    { name: "ECDSA", hash: "SHA-256" },
    key,
    asBufferSource(derToP1363(csr.signatureDer)),
    asBufferSource(csr.info),
  );
}
