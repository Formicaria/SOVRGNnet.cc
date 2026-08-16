export const ENV = {
  cookieSecret: process.env.JWT_SECRET ?? "",
  databaseUrl: process.env.DATABASE_URL ?? "",
  isProduction: process.env.NODE_ENV === "production",
  /** Internal URL of the homeserver (Docker service name in prod). */
  matrixHomeserverUrl: process.env.MATRIX_HOMESERVER_URL ?? "http://localhost:8008",
  /** The Matrix server_name — the domain in user IDs like @zach:sovrgnnet.cc. */
  matrixServerName: process.env.MATRIX_SERVER_NAME ?? "localhost",
  /**
   * Shared secret for creating Matrix accounts on the homeserver.
   *
   * Public registration stays disabled entirely; only something holding this
   * secret can create an account, and it never leaves this process. Replaces
   * the registration token used with Conduit, since Dendrite has no token
   * flow — see docs/adr/0006-dendrite-replaces-conduit.md.
   *
   * Falls back to the old variable so an existing .env keeps working across
   * the upgrade.
   */
  matrixSharedSecret:
    process.env.MATRIX_SHARED_SECRET ?? process.env.MATRIX_REGISTRATION_TOKEN ?? "",
  /** Internal URL of the Kubo (IPFS) daemon API. */
  ipfsApiUrl: process.env.IPFS_API_URL ?? "http://localhost:5001",
};
