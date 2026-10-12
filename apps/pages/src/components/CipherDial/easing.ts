export function easeInOutCubic(u: number): number {
  return u < 0.5 ? 4 * u * u * u : 1 - (-2 * u + 2) ** 3 / 2;
}

export function easeBack(u: number): number {
  const c1 = 1.9;
  const c3 = c1 + 1;
  return 1 + c3 * (u - 1) ** 3 + c1 * (u - 1) ** 2;
}

export function easeInCubic(u: number): number {
  return u * u * u;
}

export function doorEase(u: number): number {
  return easeInCubic(u) * 0.35 + easeInOutCubic(u) * 0.65;
}
