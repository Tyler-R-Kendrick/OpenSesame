import { expect, it } from "vitest";
import {
  type NativeConfiguration,
  type NativePrivateState,
  type NativeRuntime,
  emptyNativePrivate,
} from "./native-connector-schema.js";
import { nativeConnectorView } from "./native-connector-view.js";

it("recognizes Google account scope aliases without granting other scopes", () => {
  const fingerprint = "a".repeat(64);
  const requested = [
    "openid",
    "https://www.googleapis.com/auth/userinfo.email",
  ];
  const configuration: NativeConfiguration = {
    version: 1,
    providerId: "google-drive",
    method: "oauth",
    displayName: "Google",
    icon: "",
    parameters: {},
    requestedScopes: { user: requested },
    targetIds: {},
    fingerprint,
  };
  const runtime: NativeRuntime = {
    verifiedAt: 100,
    identity: {
      id: "account",
      label: "Account",
      kind: "account",
      assurance: "account-verified",
    },
    targets: [],
    grants: [
      {
        actor: "user",
        label: "Account",
        permissionState: "known",
        grantedScopes: ["openid", "email"],
        expiresAt: null,
        needsReauth: false,
      },
    ],
  };
  const privateState: NativePrivateState = {
    ...emptyNativePrivate(),
    grants: {
      user: {
        providerId: "google-drive",
        actor: "user",
        kind: "oauth",
        fingerprint,
        accessToken: "test-token",
        scopes: ["openid", "email"],
        expiresAt: null,
      },
    },
    verification: { fingerprint, verifiedAt: 100, kind: "provider" },
  };
  const view = () =>
    nativeConnectorView("native-1", 1, configuration, runtime, privateState);
  expect(view().status).toBe("connected");
  runtime.grants[0]?.grantedScopes.push(
    "https://www.googleapis.com/auth/drive.readonly",
  );
  expect(view().status).toBe("reauthorize");
  runtime.grants[0]?.grantedScopes.pop();
  requested.push("https://www.googleapis.com/auth/drive.readonly");
  expect(view().status).toBe("reauthorize");
});
