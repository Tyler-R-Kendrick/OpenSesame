/**
 * Line-faithful port of getsops/sops `shamir/shamir.go` at
 * 26e2f4784ca61353082c32dbd987c25eda086dc9 (HashiCorp Vault Shamir, MPL-2.0).
 * Share layout is `{y1..yN, x}`. Not an OpenSesame root-key scheme.
 */

function add(a: number, b: number): number {
  return (a ^ b) & 0xff;
}

function mult(a: number, b: number): number {
  let accumulator = 0;
  let i = 8;
  while (i > 0) {
    i -= 1;
    const bitOfB = (b >> i) & 1;
    const aOrZero = -bitOfB & a & 0xff;
    const zeroOr1B = -(accumulator >> 7) & 0x1b & 0xff;
    const accumulatorMultipliedByX =
      (zeroOr1B ^ ((accumulator + accumulator) & 0xff)) & 0xff;
    accumulator = (aOrZero ^ accumulatorMultipliedByX) & 0xff;
  }
  return accumulator;
}

function inverse(a: number): number {
  let b = mult(a, a);
  let c = mult(a, b);
  b = mult(c, c);
  b = mult(b, b);
  c = mult(b, c);
  b = mult(b, b);
  b = mult(b, b);
  b = mult(b, c);
  b = mult(b, b);
  b = mult(a, b);
  return mult(b, b);
}

function div(a: number, b: number): number {
  if (b === 0) {
    throw new Error("shamir divide by zero");
  }
  return mult(a, inverse(b));
}

function evaluate(coefficients: Uint8Array, x: number): number {
  if (x === 0) return coefficients[0] ?? 0;
  const degree = coefficients.length - 1;
  let out = coefficients[degree] ?? 0;
  for (let i = degree - 1; i >= 0; i -= 1) {
    const coeff = coefficients[i] ?? 0;
    out = add(mult(out, x), coeff);
  }
  return out;
}

function interpolate(
  xSamples: Uint8Array,
  ySamples: Uint8Array,
  x: number,
): number {
  const limit = xSamples.length;
  let result = 0;
  for (let i = 0; i < limit; i += 1) {
    let basis = 1;
    for (let j = 0; j < limit; j += 1) {
      if (i === j) continue;
      const num = add(x, xSamples[j] ?? 0);
      const denom = add(xSamples[i] ?? 0, xSamples[j] ?? 0);
      basis = mult(basis, div(num, denom));
    }
    const yi = ySamples[i] ?? 0;
    result = add(result, mult(yi, basis));
  }
  return result;
}

/** Split `secret` into `parts` shares; `threshold` are required to combine. */
export function shamirSplit(
  secret: Uint8Array,
  parts: number,
  threshold: number,
): Uint8Array[] {
  if (parts < threshold) throw new Error("parts cannot be less than threshold");
  if (parts > 255 || threshold > 255)
    throw new Error("parts cannot exceed 255");
  if (threshold < 2) throw new Error("threshold must be at least 2");
  if (secret.byteLength === 0) throw new Error("cannot split an empty secret");
  const out: Uint8Array[] = [];
  for (let idx = 0; idx < parts; idx += 1) {
    const share = new Uint8Array(secret.byteLength + 1);
    share[secret.byteLength] = (idx + 1) & 0xff;
    out.push(share);
  }
  for (let idx = 0; idx < secret.byteLength; idx += 1) {
    const coefficients = new Uint8Array(threshold);
    coefficients[0] = secret[idx] ?? 0;
    crypto.getRandomValues(coefficients.subarray(1));
    for (let i = 0; i < parts; i += 1) {
      const x = (i + 1) & 0xff;
      const share = out[i];
      if (!share) throw new Error("share missing");
      share[idx] = evaluate(coefficients, x);
    }
  }
  return out;
}

/** Reconstruct a secret from distinct-coordinate shares. */
export function shamirCombine(parts: readonly Uint8Array[]): Uint8Array {
  if (parts.length < 2) {
    throw new Error("less than two parts cannot reconstruct the secret");
  }
  const first = parts[0];
  if (!first || first.byteLength < 2) {
    throw new Error("parts must be at least two bytes");
  }
  for (const part of parts) {
    if (part.byteLength !== first.byteLength) {
      throw new Error("all parts must be the same length");
    }
  }
  const secret = new Uint8Array(first.byteLength - 1);
  const xSamples = new Uint8Array(parts.length);
  const ySamples = new Uint8Array(parts.length);
  const seen = new Set<number>();
  for (let i = 0; i < parts.length; i += 1) {
    const part = parts[i];
    if (!part) throw new Error("part missing");
    const samp = part[first.byteLength - 1] ?? 0;
    if (seen.has(samp)) throw new Error("duplicate part detected");
    seen.add(samp);
    xSamples[i] = samp;
  }
  for (let idx = 0; idx < secret.byteLength; idx += 1) {
    for (let i = 0; i < parts.length; i += 1) {
      const part = parts[i];
      ySamples[i] = part?.[idx] ?? 0;
    }
    secret[idx] = interpolate(xSamples, ySamples, 0);
  }
  return secret;
}
