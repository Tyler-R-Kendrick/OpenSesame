/** ICE server shapes for sealed routes and the owner's transport profile. */

export type IceServerSpec = Readonly<{
  urls: readonly string[];
  username?: string;
  credential?: string;
}>;

/** An ICE server as the owner keeps it: a REST secret mints credentials. */
export type IceServerSetting = IceServerSpec & Readonly<{ secret?: string }>;

/** An ICE server as it is read, before it is handed on. */
export type IceServerDraft = {
  urls: string[];
  username?: string;
  credential?: string;
  secret?: string;
};
