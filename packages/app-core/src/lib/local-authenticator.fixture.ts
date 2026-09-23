import { b64urlToBytes, bytesToB64url } from "@opensesame/sdk-browser";
export const origin = "https://iam.example.test";
export const rpID = "iam.example.test";
const encode = (value: string) => new TextEncoder().encode(value);
function concat(...parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(parts.flatMap((part) => Array.from(part)));
}
function bytes(value: BufferSource) {
  return value instanceof ArrayBuffer
    ? new Uint8Array(value)
    : new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
}
const octets = (...values: number[]) => Uint8Array.from(values);

function integer(value: Uint8Array) {
  let offset = 0;
  while (offset < value.length - 1 && value[offset] === 0) offset++;
  const trimmed = value.slice(offset);
  const first = trimmed[0];
  if (first === undefined) throw new Error("Empty integer");
  const positive = first & 0x80 ? concat(octets(0), trimmed) : trimmed;
  return concat(octets(2, positive.length), positive);
}

function noneAttestation(data: Uint8Array) {
  return concat(
    octets(0xa3, 0x63),
    encode("fmt"),
    octets(0x64),
    encode("none"),
    octets(0x67),
    encode("attStmt"),
    octets(0xa0, 0x68),
    encode("authData"),
    octets(0x58, data.length),
    data,
  );
}

type AuthenticatorControl = {
  userVerified: boolean;
  wrongChallenge: boolean;
  wrongOrigin: boolean;
  badSignature: boolean;
};

function clientData(
  control: AuthenticatorControl,
  type: string,
  challenge: BufferSource,
) {
  return encode(
    JSON.stringify({
      type,
      challenge: control.wrongChallenge
        ? "other"
        : bytesToB64url(bytes(challenge)),
      origin: control.wrongOrigin ? "https://attacker.example.test" : origin,
      crossOrigin: false,
    }),
  );
}

/** Fixed ES256 virtual authenticator fixture, not a production CBOR/DER codec. */
export async function authenticator() {
  const pair = await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  );
  const jwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
  if (!jwk.x || !jwk.y) throw new Error("Missing EC coordinates");
  const cose = concat(
    octets(0xa5, 1, 2, 3, 0x26, 0x20, 1, 0x21, 0x58, 32),
    b64urlToBytes(jwk.x),
    octets(0x22, 0x58, 32),
    b64urlToBytes(jwk.y),
  );
  const id = crypto.getRandomValues(new Uint8Array(32));
  const rpHash = new Uint8Array(
    await crypto.subtle.digest("SHA-256", encode(rpID)),
  );
  let userId = new Uint8Array();
  let counter = 0;
  const control = {
    userVerified: true,
    wrongOrigin: false,
    wrongChallenge: false,
    badSignature: false,
  };
  return {
    control,
    async create(options: CredentialCreationOptions) {
      const request = options.publicKey;
      if (!request) throw new Error("Missing options");
      userId = Uint8Array.from(bytes(request.user.id));
      const data = concat(
        rpHash,
        octets(control.userVerified ? 0x45 : 0x41, 0, 0, 0, 0),
        new Uint8Array(16),
        octets(0, id.length),
        id,
        cose,
      );
      const attestation = noneAttestation(data);
      return {
        id: bytesToB64url(id),
        rawId: id.buffer,
        type: "public-key",
        response: {
          clientDataJSON: clientData(
            control,
            "webauthn.create",
            request.challenge,
          ).buffer,
          attestationObject: attestation.buffer,
        },
        getClientExtensionResults: () => ({}),
      };
    },
    async get(options: CredentialRequestOptions) {
      const request = options.publicKey;
      if (!request) throw new Error("Missing options");
      counter++;
      const data = concat(
        rpHash,
        octets(control.userVerified ? 5 : 1, 0, 0, 0, counter),
      );
      const client = clientData(control, "webauthn.get", request.challenge);
      const hash = new Uint8Array(
        await crypto.subtle.digest("SHA-256", client),
      );
      const signature = new Uint8Array(
        await crypto.subtle.sign(
          { name: "ECDSA", hash: "SHA-256" },
          pair.privateKey,
          concat(data, hash),
        ),
      );
      if (control.badSignature) signature.fill(0);
      const sequence = concat(
        integer(signature.slice(0, 32)),
        integer(signature.slice(32)),
      );
      return {
        id: bytesToB64url(id),
        rawId: id.buffer,
        type: "public-key",
        response: {
          clientDataJSON: client.buffer,
          authenticatorData: data.buffer,
          signature: concat(octets(0x30, sequence.length), sequence).buffer,
          userHandle: userId.buffer,
        },
        getClientExtensionResults: () => ({}),
      };
    },
  };
}
