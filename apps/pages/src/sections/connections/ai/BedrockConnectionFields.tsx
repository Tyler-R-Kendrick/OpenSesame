import type { bedrockCredential } from "@opensesame/app-core/lib/ai-connections/bedrock-target.js";
import { z } from "zod";
import { FieldShell } from "../../../components/FieldShell.js";
import type { AiConnectionFormProps } from "./AiConnectionForm.js";

type Props = Pick<
  AiConnectionFormProps,
  "draft" | "busy" | "saved" | "onChange"
>;
type Credential = {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken: string;
};
const labels = {
  accessKeyId: "AWS access key ID",
  secretAccessKey: "AWS secret access key",
  sessionToken: "AWS session token (optional)",
} as const;
const EnteredCredential = z
  .object({
    accessKeyId: z.string().default(""),
    secretAccessKey: z.string().default(""),
    sessionToken: z.string().default(""),
  })
  .strict();
function enteredCredential(value: string): Credential {
  try {
    const parsed = EnteredCredential.safeParse(JSON.parse(value));
    if (parsed.success) return parsed.data;
  } catch {
    // An empty or unfinished credential cannot enable Test or Save.
  }
  return { accessKeyId: "", secretAccessKey: "", sessionToken: "" };
}
/** Native and BYO Converse compose the same region and write-only credential fields. */
export function BedrockConnectionFields({
  draft,
  busy,
  saved,
  onChange,
}: Props) {
  const target = draft.bedrock;
  const credential = enteredCredential(draft.apiKey);
  if (!target) return null;
  function change(field: keyof Credential, value: string) {
    const next = { ...credential, [field]: value };
    const wire: ReturnType<typeof bedrockCredential> = {
      accessKeyId: next.accessKeyId,
      secretAccessKey: next.secretAccessKey,
    };
    if (next.sessionToken) wire.sessionToken = next.sessionToken;
    onChange("apiKey", JSON.stringify(wire));
  }
  return (
    <>
      <FieldShell
        label="AWS region"
        value={target.region}
        mono
        disabled={busy}
        onValueChange={(region) => onChange("bedrock", { ...target, region })}
      />
      {(["accessKeyId", "secretAccessKey", "sessionToken"] as const).map(
        (field) => (
          <FieldShell
            key={field}
            label={labels[field]}
            value={credential[field]}
            type="password"
            autoComplete="new-password"
            disabled={busy}
            placeholder={
              saved
                ? "Saved in the owning vault; enter a replacement"
                : undefined
            }
            onValueChange={(value) => change(field, value)}
          />
        ),
      )}
    </>
  );
}
export function BedrockConnectionHelp() {
  return (
    <details className="conn-client-alt">
      <summary>Connection setup</summary>
      <p>
        Choose a model that supports text Converse in this AWS region. Enter
        your AWS access key ID and secret access key. Temporary credentials also
        need a session token. Credentials stay sealed in the owning vault;
        requests use the approved PWA network transport.
      </p>
      <p>
        Credentials need permission to invoke this model. Testing and saving
        send a short prompt with up to 16 output tokens. Changing the endpoint,
        region or model requires entering the credential again. Answers appear
        when the Converse request completes.
      </p>
    </details>
  );
}
