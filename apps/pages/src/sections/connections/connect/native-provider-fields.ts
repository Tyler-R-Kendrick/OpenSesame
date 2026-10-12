/** Provider fields come from the compiled contract, including private secondary credentials. */
import type { ApiKeyPreset } from "@opensesame/app-core/lib/connect-plan.js";
import type { NativeField } from "./native-connector-ui.js";

type Parameter = ApiKeyPreset["templateParams"][number];

export function providerParameterField(parameter: Parameter): NativeField {
  return {
    id: parameter.name,
    label: parameter.label,
    kind: parameter.choices ? "choice" : "text",
    secret: parameter.secret,
    required: parameter.required,
    placeholder: parameter.placeholder,
    choices: parameter.choices?.map((choice) => ({
      id: choice.value,
      label: choice.label,
    })),
  };
}

function credentialFields(
  preset: Pick<ApiKeyPreset, "templateParams" | "additionalCredentials">,
): NativeField[] {
  return [
    ...preset.templateParams.map(providerParameterField),
    ...preset.additionalCredentials.map((field) => ({
      id: field.name,
      label: field.label,
      kind: "text" as const,
      secret: true,
      required: field.required,
      placeholder: field.placeholder,
    })),
  ];
}

export function providerApiKeyFields(
  name: string,
  preset: ApiKeyPreset,
): NativeField[] {
  const primary: NativeField = {
    id: "api_key",
    label: `${name} API key`,
    kind: "text",
    secret: true,
    required: true,
    placeholder: preset.keyPrefix ?? undefined,
  };
  if (preset.credentialVariants.length === 0)
    return [primary, ...credentialFields(preset)];
  return [
    {
      id: "credential_variant",
      label: "Credential type",
      kind: "choice",
      secret: false,
      required: true,
      choices: preset.credentialVariants.map((variant) => ({
        id: variant.id,
        label: variant.label,
      })),
      defaultValue: preset.credentialVariants[0]?.id,
    },
    ...preset.credentialVariants.flatMap((variant) =>
      [
        {
          ...primary,
          label: `${name} ${variant.label}`,
          help: variant.description,
        },
        ...credentialFields(variant),
      ].map((field) => ({
        ...field,
        when: { fieldId: "credential_variant", value: variant.id },
      })),
    ),
  ];
}
