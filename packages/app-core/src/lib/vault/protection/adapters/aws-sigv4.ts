/**
 * Minimal AWS SigV4 signer for KMS JSON-1.1 over HTTPS (browser + Node).
 * Only signs POST bodies we construct — never logs credentials or plaintext.
 */

function toHex(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function sha256HexBytes(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return toHex(new Uint8Array(digest));
}

async function sha256HexText(text: string): Promise<string> {
  return sha256HexBytes(new TextEncoder().encode(text));
}

async function hmac(
  key: ArrayBuffer | Uint8Array,
  data: string,
): Promise<ArrayBuffer> {
  const raw = key instanceof Uint8Array ? key : new Uint8Array(key);
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    raw,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return crypto.subtle.sign("HMAC", cryptoKey, new TextEncoder().encode(data));
}

async function signingKey(
  secret: string,
  dateStamp: string,
  region: string,
  service: string,
): Promise<ArrayBuffer> {
  const kDate = await hmac(
    new TextEncoder().encode(`AWS4${secret}`),
    dateStamp,
  );
  const kRegion = await hmac(kDate, region);
  const kService = await hmac(kRegion, service);
  return hmac(kService, "aws4_request");
}

export type AwsSigV4Credentials = {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
};

export type AwsHeaderMap = {
  "content-type": string;
  host: string;
  "x-amz-date": string;
  "x-amz-target": string;
  authorization?: string;
  "x-amz-security-token"?: string;
};

export type SignedAwsRequest = {
  url: string;
  headers: AwsHeaderMap;
  body: string;
};

/** Sign a KMS `application/x-amz-json-1.1` POST. */
export async function signAwsKmsJsonPost(input: {
  region: string;
  target: "TrentService.Encrypt" | "TrentService.Decrypt";
  body: Record<string, string | Record<string, string>>;
  credentials: AwsSigV4Credentials;
  now?: Date;
}): Promise<SignedAwsRequest> {
  const now = input.now ?? new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
  const dateStamp = amzDate.slice(0, 8);
  const host = `kms.${input.region}.amazonaws.com`;
  const url = `https://${host}/`;
  const payload = JSON.stringify(input.body);
  const payloadHash = await sha256HexText(payload);
  const canonicalHeaders = [
    "content-type:application/x-amz-json-1.1",
    `host:${host}`,
    `x-amz-date:${amzDate}`,
    `x-amz-target:${input.target}`,
  ];
  const headers: SignedAwsRequest["headers"] = {
    "content-type": "application/x-amz-json-1.1",
    host,
    "x-amz-date": amzDate,
    "x-amz-target": input.target,
  };
  if (input.credentials.sessionToken) {
    headers["x-amz-security-token"] = input.credentials.sessionToken;
    canonicalHeaders.push(
      `x-amz-security-token:${input.credentials.sessionToken}`,
    );
  }
  canonicalHeaders.sort();
  const signedHeaderNames = canonicalHeaders
    .map((line) => {
      const name = line.split(":")[0];
      if (name === undefined || name === "") {
        throw new Error("canonical_header_malformed");
      }
      return name;
    })
    .join(";");
  const canonicalRequest = [
    "POST",
    "/",
    "",
    `${canonicalHeaders.join("\n")}\n`,
    signedHeaderNames,
    payloadHash,
  ].join("\n");
  const credentialScope = `${dateStamp}/${input.region}/kms/aws4_request`;
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    credentialScope,
    await sha256HexText(canonicalRequest),
  ].join("\n");
  const key = await signingKey(
    input.credentials.secretAccessKey,
    dateStamp,
    input.region,
    "kms",
  );
  const signature = toHex(new Uint8Array(await hmac(key, stringToSign)));
  headers.authorization = [
    `AWS4-HMAC-SHA256 Credential=${input.credentials.accessKeyId}/${credentialScope}`,
    `SignedHeaders=${signedHeaderNames}`,
    `Signature=${signature}`,
  ].join(", ");
  return { url, headers, body: payload };
}
