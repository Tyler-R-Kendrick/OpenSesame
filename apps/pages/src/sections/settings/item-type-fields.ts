export type FieldPreview = { id: string; type: string; label: string };

function fieldsFromSection(section: unknown): FieldPreview[] {
  if (!section || typeof section !== "object") return [];
  const listed = (section as { fields?: unknown }).fields;
  if (!Array.isArray(listed)) return [];
  const fields: FieldPreview[] = [];
  for (const field of listed) {
    if (!field || typeof field !== "object") continue;
    const row = field as { id?: unknown; type?: unknown; label?: unknown };
    if (typeof row.id === "string" && typeof row.type === "string") {
      fields.push({
        id: row.id,
        type: row.type,
        label: typeof row.label === "string" ? row.label : row.id,
      });
    }
  }
  return fields;
}

export function fieldsOfDefinition(text: string): FieldPreview[] {
  try {
    const parsed: unknown = JSON.parse(text);
    if (!parsed || typeof parsed !== "object") return [];
    const spec = (parsed as { spec?: { sections?: unknown } }).spec;
    if (!spec || typeof spec !== "object") return [];
    const sections = spec.sections;
    if (!Array.isArray(sections)) return [];
    return sections.flatMap(fieldsFromSection);
  } catch {
    return [];
  }
}
