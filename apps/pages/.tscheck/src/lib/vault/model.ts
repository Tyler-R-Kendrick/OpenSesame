export type CapabilityGrant = { action: string; resource: string };

type Base = {
  id: string;
  name: string;
  folderId: string | null;
  favorite: boolean;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
};

export type SecretItem = Base & {
  kind: "secret";
  value: string;
  ceiling: CapabilityGrant[];
  grantees: string[];
  connectionRef: string;
};

export type LoginItem = Base & {
  kind: "login";
  username: string;
  password: string;
  uris: string[];
};

export type VaultItem = SecretItem | LoginItem;
