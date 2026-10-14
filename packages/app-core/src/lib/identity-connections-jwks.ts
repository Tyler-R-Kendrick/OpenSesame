/** Parse public signing keys and preserve exact optional fields for every client host. */
import type { BoundaryValue } from "@opensesame/os-domain";
import { z } from "zod";

const PublicJwkSchema = z.object({
  kty: z.string(),
  kid: z.string().optional(),
  alg: z.string().optional(),
  use: z.string().optional(),
  key_ops: z.array(z.string()).optional(),
  crv: z.string().optional(),
  x: z.string().optional(),
  y: z.string().optional(),
  n: z.string().optional(),
  e: z.string().optional(),
});
const JwksSchema = z.object({ keys: z.array(PublicJwkSchema) });

type IdentityPublicJwk = {
  kty: string;
  kid?: string;
  alg?: string;
  use?: string;
  key_ops?: string[];
  crv?: string;
  x?: string;
  y?: string;
  n?: string;
  e?: string;
};
type IdentityPublicJwks = { keys: IdentityPublicJwk[] };

function exactPublicJwk(
  input: z.infer<typeof PublicJwkSchema>,
): IdentityPublicJwk {
  const key: IdentityPublicJwk = { kty: input.kty };
  if (input.kid !== undefined) key.kid = input.kid;
  if (input.alg !== undefined) key.alg = input.alg;
  if (input.use !== undefined) key.use = input.use;
  if (input.key_ops !== undefined) key.key_ops = input.key_ops;
  if (input.crv !== undefined) key.crv = input.crv;
  if (input.x !== undefined) key.x = input.x;
  if (input.y !== undefined) key.y = input.y;
  if (input.n !== undefined) key.n = input.n;
  if (input.e !== undefined) key.e = input.e;
  return key;
}

export function parseIdentityPublicJwks(
  input: BoundaryValue,
): IdentityPublicJwks {
  const parsed = JwksSchema.parse(input);
  return { keys: parsed.keys.map(exactPublicJwk) };
}
