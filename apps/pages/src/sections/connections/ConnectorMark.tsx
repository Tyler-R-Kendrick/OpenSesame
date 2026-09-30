/**
 * A connector's brand mark on a neutral tile. Falls back to a monogram when
 * no official mark is distributable, so unknown and custom connectors still
 * read as first-class.
 *
 * Brand paths live in `connector-marks.ts` (simple-icons) and install here
 * only while Connections is on (ADR 0153). Microsoft's squares are data.
 */

const MICROSOFT_TILES = [
  { x: 1, y: 1, fill: "#F25022" },
  { x: 13, y: 1, fill: "#7FBA00" },
  { x: 1, y: 13, fill: "#00A4EF" },
  { x: 13, y: 13, fill: "#FFB900" },
];

const MICROSOFT_PROVIDER_IDS = new Set([
  "microsoft",
  "azure-kms",
  "azure-sm",
  "azure-ac",
  "azure-openai",
]);

type MarkPath = { path: string; hex: string | null };

export const connectorMarkLookup: {
  find: (providerId: string) => MarkPath | null;
} = {
  find: () => null,
};

export function resetConnectorMarkLookup(): void {
  connectorMarkLookup.find = () => null;
}

function monogram(displayName: string): string {
  const letter = displayName.trim().charAt(0);
  return letter ? letter.toLocaleUpperCase() : "?";
}
export function ConnectorMark({
  providerId,
  displayName,
  size = 36,
}: {
  providerId: string;
  displayName: string;
  size?: number;
}) {
  const icon = Math.round(size * 0.55);
  if (MICROSOFT_PROVIDER_IDS.has(providerId)) {
    return (
      <span
        className="conn-mark"
        style={{ width: size, height: size }}
        aria-hidden="true"
      >
        <svg width={icon} height={icon} viewBox="0 0 24 24" aria-hidden="true">
          {MICROSOFT_TILES.map((tile) => (
            <rect
              key={`${tile.x}-${tile.y}`}
              x={tile.x}
              y={tile.y}
              width="10"
              height="10"
              fill={tile.fill}
            />
          ))}
        </svg>
      </span>
    );
  }

  const mark = connectorMarkLookup.find(providerId);
  if (!mark) {
    return (
      <span
        className="conn-mark conn-mark--monogram"
        style={{ width: size, height: size, fontSize: size * 0.42 }}
        aria-hidden="true"
      >
        {monogram(displayName)}
      </span>
    );
  }

  return (
    <span
      className={`conn-mark${mark.hex ? "" : " conn-mark--ink"}`}
      style={{ width: size, height: size }}
      aria-hidden="true"
    >
      <svg
        width={icon}
        height={icon}
        viewBox="0 0 24 24"
        aria-hidden="true"
        fill={mark.hex ?? "currentColor"}
      >
        <path d={mark.path} />
      </svg>
    </span>
  );
}
