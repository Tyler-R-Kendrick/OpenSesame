import { expect, it } from "vitest";
import { NativePendingSchema } from "./native-connector-schema.js";

const pending = {
  actor: "user",
  fingerprint: "a".repeat(64),
  state: `st_${"A".repeat(20)}`,
  verifier: "a".repeat(64),
  redirectUri: "https://self-host.example.org/auth/native-connector.html",
  createdAt: 1,
  expiresAt: 100,
  scopes: [],
};

it.each(["vault", "openbao"])(
  "accepts %s's actual 23-byte native state without replacing it",
  (providerId) => {
    expect(NativePendingSchema.parse({ ...pending, providerId }).state).toBe(
      pending.state,
    );
  },
);
it.each(["discord", "twitch", "microsoft", "vercel"])(
  "retains the minimum for app-generated %s state",
  (providerId) => {
    expect(
      NativePendingSchema.safeParse({ ...pending, providerId }).success,
    ).toBe(false);
    expect(
      NativePendingSchema.safeParse({
        ...pending,
        providerId,
        state: "a".repeat(43),
      }).success,
    ).toBe(true);
  },
);
it.each(["short", `st_${" ".repeat(20)}`])(
  "refuses unusable native state",
  (state) => {
    expect(
      NativePendingSchema.safeParse({ ...pending, providerId: "vault", state })
        .success,
    ).toBe(false);
  },
);
