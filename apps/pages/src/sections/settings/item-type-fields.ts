import {
  type BoundaryValue,
  isJsonObject,
  isString,
  overlapCast,
} from "@opensesame/os-domain";

export type FieldPreview = { id: string; type: string; label: string };

function fieldsFromSection(section: BoundaryValue): FieldPreview[] {
  if (!isJsonObject(section)) return [];
  const listed = section.fields;
  if (!Array.isArray(listed)) return [];
  const fields: FieldPreview[] = [];
  for (const field of listed) {
    if (!isJsonObject(field)) continue;
    if (isString(field.id) && isString(field.type)) {
      fields.push({
        id: field.id,
        type: field.type,
        label: isString(field.label) ? field.label : field.id,
      });
    }
  }
  return fields;
}

export function fieldsOfDefinition(text: string): FieldPreview[] {
  try {
    const parsed: BoundaryValue = overlapCast(JSON.parse(text));
    if (!isJsonObject(parsed)) return [];
    const spec = parsed.spec;
    if (!isJsonObject(spec)) return [];
    const sections = spec.sections;
    if (!Array.isArray(sections)) return [];
    return sections.flatMap(fieldsFromSection);
  } catch {
    return [];
  }
}
