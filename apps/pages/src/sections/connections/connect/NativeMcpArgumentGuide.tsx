/** Read-only guidance comes from the server's actual advertised schema. */
import { z } from "zod";

const MAX_SCHEMA_BYTES = 32768;
const ArgumentSchema = z.object({
  type: z.literal("object"),
  required: z.array(z.string().min(1)).optional(),
});

export function nativeMcpArgumentGuide(schema: string | undefined) {
  if (!schema || new TextEncoder().encode(schema).length > MAX_SCHEMA_BYTES)
    return null;
  try {
    const parsed = ArgumentSchema.safeParse(JSON.parse(schema));
    if (!parsed.success) return null;
    return { schema, required: parsed.data.required ?? [] };
  } catch {
    return null;
  }
}

export function NativeMcpArgumentGuide({ schema }: { schema: string }) {
  const guide = nativeMcpArgumentGuide(schema);
  if (!guide) return null;
  return (
    <div className="cx-form">
      <p className="hint">
        Required fields:{" "}
        <code>{guide.required.join(", ") || "None advertised"}</code>
      </p>
      <details className="cx-application">
        <summary>Advertised argument schema</summary>
        <pre
          className="cx-argument-schema"
          aria-label="Advertised argument schema"
        >
          {guide.schema}
        </pre>
      </details>
    </div>
  );
}
