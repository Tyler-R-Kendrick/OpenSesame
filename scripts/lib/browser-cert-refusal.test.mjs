import assert from "node:assert/strict";
import { test } from "vitest";
import { isClientCertificateRefusal } from "../../apps/pages/scripts/lib/browser-cert-refusal.mjs";

test("recognizes Chrome's specific missing-client-certificate navigation failure", () => {
  assert.equal(
    isClientCertificateRefusal({
      status: 0,
      error:
        "page.goto: net::ERR_BAD_SSL_CLIENT_AUTH_CERT at https://localhost:443/probe",
      body: "Access to localhost was denied",
    }),
    true,
  );
});

test("retains the TLS alert and Playwright proxy diagnostics", () => {
  assert.equal(
    isClientCertificateRefusal({
      status: 0,
      error: "tlsv13 alert certificate required",
    }),
    true,
  );
  assert.equal(
    isClientCertificateRefusal({
      status: 503,
      body: "Playwright client-certificate error: tlsv13 alert certificate required",
    }),
    true,
  );
});

test("never treats generic navigation, trust or server failures as certificate refusal", () => {
  for (const error of [
    "",
    "Timeout 30000ms exceeded",
    "net::ERR_CONNECTION_REFUSED",
    "net::ERR_NAME_NOT_RESOLVED",
    "net::ERR_CERT_AUTHORITY_INVALID",
    "net::ERR_SSL_PROTOCOL_ERROR",
    "net::ERR_BAD_SSL_CLIENT_AUTH_CERT_OTHER",
  ]) {
    assert.equal(
      isClientCertificateRefusal({ status: 0, error }),
      false,
      error,
    );
  }
  assert.equal(
    isClientCertificateRefusal({
      status: 0,
      body: "Access to localhost was denied",
    }),
    false,
  );
  assert.equal(
    isClientCertificateRefusal({ status: 503, body: "certificate required" }),
    false,
  );
});

test("HTTP admission responses cannot stand in for handshake refusal", () => {
  for (const status of [200, 401, 403, 404, 500]) {
    assert.equal(
      isClientCertificateRefusal({
        status,
        error: "net::ERR_BAD_SSL_CLIENT_AUTH_CERT",
        body: "Playwright client-certificate error: certificate required",
      }),
      false,
    );
  }
});
