/** Observe actual HTTP packets, publishing only closed boolean transport evidence. */
import assert from "node:assert/strict";
const fields = [
  "v",
  "packageId",
  "receiverId",
  "bindingId",
  "keyEpoch",
  "issuedAt",
  "expiresAt",
  "nonceB64",
  "ciphertextB64",
  "macB64",
].sort();
export function observeSealedRequests(page, receiver, forbidden) {
  const requests = [];
  page.on("request", (request) => {
    if (
      new URL(request.url()).origin !== receiver.origin ||
      request.method() !== "POST"
    )
      return;
    const proof = request
      .allHeaders()
      .then((headers) => {
        const body = request.postData() ?? "";
        const packet = JSON.parse(body);
        return {
          fixedRoute:
            new URL(request.url()).pathname === "/v1/credential-observations",
          noAmbientCredentials: !headers.cookie && !headers.authorization,
          bounded: Buffer.byteLength(body) <= 8192,
          closedPacketFields:
            JSON.stringify(Object.keys(packet).sort()) ===
            JSON.stringify(fields),
          noSecretText: forbidden.every((secret) => !body.includes(secret)),
        };
      })
      .catch(() => ({ observationFailed: true }));
    requests.push(proof);
  });
  return async () => {
    const evidence = await Promise.all(requests);
    assert.ok(
      evidence.length >= 2,
      "actual test and retired observation HTTP requests are captured",
    );
    for (const request of evidence)
      assert.deepEqual(Object.values(request), [true, true, true, true, true]);
    return {
      actualRequests: evidence.length,
      fixedRoute: true,
      boundedSealedPackages: true,
      noAmbientCredentials: true,
      noSecretText: true,
    };
  };
}
