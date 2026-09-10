export type TursoConnectOptions = {
  path: string;
  url?: string;
  authToken?: () => Promise<string>;
  clientName: string;
};

async function connectDefault(options: TursoConnectOptions) {
  const { connect } = await import("@tursodatabase/sync-wasm/vite");
  return connect(options);
}

export const tursoConnectSeams = {
  connect: connectDefault,
};

export async function connectTurso(options: TursoConnectOptions) {
  return tursoConnectSeams.connect(options);
}
