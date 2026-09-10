export const DROP_TTL_OPTIONS = [
  { label: "10 minutes", ms: 600_000 },
  { label: "1 hour", ms: 3_600_000 },
  { label: "1 day", ms: 86_400_000 },
] as const;

export function TtlPicker({
  value,
  onChange,
}: {
  value: number;
  onChange: (ms: number) => void;
}) {
  return (
    <div className="field">
      <label htmlFor="drop-ttl">Opens for</label>
      <select
        id="drop-ttl"
        value={String(value)}
        onChange={(event) => onChange(Number(event.target.value))}
      >
        {DROP_TTL_OPTIONS.map((option) => (
          <option key={option.ms} value={option.ms}>
            {option.label}
          </option>
        ))}
      </select>
    </div>
  );
}
