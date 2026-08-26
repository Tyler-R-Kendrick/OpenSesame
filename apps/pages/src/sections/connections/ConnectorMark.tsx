import {
  MICROSOFT_PROVIDER_IDS,
  MICROSOFT_TILES,
  connectorMark,
  monogram,
} from "./connector-marks.js";

/**
 * A connector's brand mark on a neutral tile. Falls back to a monogram when
 * no official mark is distributable, so unknown and custom connectors still
 * read as first-class.
 */
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

  const mark = connectorMark(providerId);
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
