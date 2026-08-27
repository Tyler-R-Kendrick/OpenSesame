import { z } from "zod";

const LOOPBACK = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

export function isAuthenticationRpId(value: string): boolean {
  if (value === "localhost") return true;
  if (value.length > 253 || value.includes(":") || value.includes("/"))
    return false;
  return value
    .split(".")
    .every(
      (label) =>
        label.length > 0 &&
        label.length <= 63 &&
        /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i.test(label),
    );
}

export function originMatchesRpId(raw: string, rpId: string): boolean {
  try {
    const url = new URL(raw);
    if (url.username || url.password || url.search || url.hash) return false;
    if (url.pathname !== "/") return false;
    if (
      url.protocol !== "https:" &&
      !(url.protocol === "http:" && LOOPBACK.has(url.hostname))
    ) {
      return false;
    }
    const host = url.hostname.toLowerCase();
    const rp = rpId.toLowerCase();
    return host === rp || host.endsWith(`.${rp}`);
  } catch {
    return false;
  }
}

export const CreateAuthenticationApplicationRequestSchema = z
  .object({
    displayName: z.string().trim().min(1).max(128),
    rpId: z.string().trim().toLowerCase().refine(isAuthenticationRpId),
    origins: z.array(z.string().url()).min(1).max(16),
    organizationId: z.string().min(1).max(256).optional(),
  })
  .superRefine((value, ctx) => {
    for (const origin of value.origins) {
      if (!originMatchesRpId(origin, value.rpId)) {
        ctx.addIssue({
          code: "custom",
          path: ["origins"],
          message:
            "origins must be https (or loopback http) and match the RP ID",
        });
      }
    }
  });

export const AuthenticationConfigurationSchema = z.object({
  purpose: z.string().regex(/^[A-Za-z0-9_-]{1,255}$/),
  timeToLiveSeconds: z.number().int().min(1).max(86_400),
  userVerification: z.enum(["discouraged", "preferred", "required"]),
  hints: z
    .array(z.enum(["client-device", "hybrid", "security-key"]))
    .max(3)
    .default([]),
});

export const AuthenticationConfigurationRequestSchema =
  AuthenticationConfigurationSchema.extend({
    applicationId: z.string().min(1).max(256),
  });

export const AuthenticationConfigurationApplicationRequestSchema = z.object({
  applicationId: z.string().min(1).max(256),
});

export const PatchAuthenticationApplicationRequestSchema = z
  .object({
    displayName: z.string().trim().min(1).max(128).optional(),
    state: z.enum(["active", "suspended", "revoked"]).optional(),
    manualTokensEnabled: z.boolean().optional(),
    magicLinksEnabled: z.boolean().optional(),
    configurations: z
      .array(AuthenticationConfigurationSchema)
      .min(2)
      .max(32)
      .optional(),
  })
  .superRefine((value, ctx) => {
    if (!value.configurations) return;
    const purposes = value.configurations.map(
      (configuration) => configuration.purpose,
    );
    if (
      new Set(purposes).size !== purposes.length ||
      !purposes.includes("sign-in") ||
      !purposes.includes("step-up")
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["configurations"],
        message:
          "configurations must be unique and include sign-in and step-up",
      });
    }
  });

export const CreateRegistrationTokenRequestSchema = z.object({
  applicationId: z.string().min(1).max(256),
  userId: z.string().min(1).max(1024),
  userName: z.string().trim().min(1).max(320),
  displayName: z.string().trim().min(1).max(320),
  aliases: z.array(z.string().trim().min(1).max(320)).max(16).default([]),
  aliasHashing: z.boolean().default(true),
  authenticatorAttachment: z.enum(["cross-platform", "platform"]).optional(),
  userVerification: z
    .enum(["discouraged", "preferred", "required"])
    .default("preferred"),
});

const PublicKeyResponseBaseSchema = z.object({
  id: z.string().min(1).max(4096),
  rawId: z.string().min(1).max(4096),
  type: z.literal("public-key"),
  clientExtensionResults: z.record(z.unknown()).default({}),
});

export const RegistrationResponseSchema = PublicKeyResponseBaseSchema.extend({
  response: z.object({
    clientDataJSON: z.string().min(1).max(131_072),
    attestationObject: z.string().min(1).max(131_072),
    transports: z
      .array(
        z.enum([
          "ble",
          "cable",
          "hybrid",
          "internal",
          "nfc",
          "smart-card",
          "usb",
        ]),
      )
      .max(8)
      .optional(),
  }),
  authenticatorAttachment: z.enum(["cross-platform", "platform"]).optional(),
});

export const AuthenticationResponseSchema = PublicKeyResponseBaseSchema.extend({
  response: z.object({
    clientDataJSON: z.string().min(1).max(131_072),
    authenticatorData: z.string().min(1).max(131_072),
    signature: z.string().min(1).max(131_072),
    userHandle: z.string().max(4096).optional(),
  }),
  authenticatorAttachment: z.enum(["cross-platform", "platform"]).optional(),
});

export const AuthenticationRegistrationOptionsRequestSchema = z.object({
  applicationId: z.string().min(1).max(256),
  token: z.string().startsWith("ort_").max(256),
});

export const AuthenticationRegistrationVerifyRequestSchema = z.object({
  applicationId: z.string().min(1).max(256),
  response: RegistrationResponseSchema,
  name: z.string().trim().min(1).max(128).optional(),
});

export const AuthenticationOptionsRequestSchema = z
  .object({
    applicationId: z.string().min(1).max(256),
    mode: z.enum(["autofill", "discoverable", "alias", "user_id"]),
    alias: z.string().min(1).max(320).optional(),
    userId: z.string().min(1).max(1024).optional(),
    purpose: z
      .string()
      .regex(/^[A-Za-z0-9_-]{1,255}$/)
      .default("sign-in"),
  })
  .superRefine((value, ctx) => {
    if (value.mode === "alias" && !value.alias) {
      ctx.addIssue({
        code: "custom",
        path: ["alias"],
        message: "alias is required",
      });
    }
    if (value.mode === "user_id" && !value.userId) {
      ctx.addIssue({
        code: "custom",
        path: ["userId"],
        message: "userId is required",
      });
    }
  });

export const AuthenticationVerifyRequestSchema = z.object({
  applicationId: z.string().min(1).max(256),
  response: AuthenticationResponseSchema,
});

export const AuthenticationTokenVerifyRequestSchema = z.object({
  applicationId: z.string().min(1).max(256),
  token: z.string().startsWith("ost_").max(256),
});

export const RenameAuthenticationCredentialRequestSchema = z.object({
  name: z.string().trim().min(1).max(128).nullable(),
});

export const PatchAuthenticationApiKeyRequestSchema = z.object({
  state: z.enum(["active", "locked"]),
});

export const GenerateAuthenticationTokenRequestSchema = z.object({
  applicationId: z.string().min(1).max(256),
  userId: z.string().min(1).max(1024),
  purpose: z
    .string()
    .regex(/^[A-Za-z0-9_-]{1,255}$/)
    .default("sign-in"),
  timeToLiveSeconds: z.number().int().min(1).max(86_400).optional(),
});

export const SetAuthenticationAliasesRequestSchema = z.object({
  applicationId: z.string().min(1).max(256),
  userId: z.string().min(1).max(1024),
  aliases: z.array(z.string().trim().min(1).max(250)).max(10),
  hashing: z.boolean().default(true),
});

export const AuthenticationCredentialsRequestSchema = z.object({
  applicationId: z.string().min(1).max(256),
  userId: z.string().min(1).max(1024),
});

export const DeleteAuthenticationCredentialRequestSchema = z.object({
  applicationId: z.string().min(1).max(256),
  credentialId: z.string().min(1).max(4096),
});

export const SendAuthenticationMagicLinkRequestSchema = z.object({
  applicationId: z.string().min(1).max(256),
  emailAddress: z.string().email().max(320),
  userId: z.string().min(1).max(1024),
  urlTemplate: z
    .string()
    .max(2048)
    .refine(
      (value) => value.includes("$TOKEN"),
      "urlTemplate must contain $TOKEN",
    )
    .refine((value) => {
      try {
        new URL(value.replace("$TOKEN", "token"));
        return true;
      } catch {
        return false;
      }
    }, "urlTemplate must be a URL"),
  timeToLiveSeconds: z.number().int().min(1).max(86_400).default(3_600),
  purpose: z
    .string()
    .regex(/^[A-Za-z0-9_-]{1,255}$/)
    .default("sign-in"),
});
