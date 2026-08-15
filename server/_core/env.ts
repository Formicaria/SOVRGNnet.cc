export const ENV = {
  cookieSecret: process.env.JWT_SECRET ?? "",
  databaseUrl: process.env.DATABASE_URL ?? "",
  isProduction: process.env.NODE_ENV === "production",
  /** Internal URL of the Conduit homeserver (Docker service name in prod). */
  matrixHomeserverUrl: process.env.MATRIX_HOMESERVER_URL ?? "http://localhost:8008",
  /** The Matrix server_name — the domain in user IDs like @zach:sovrgnnet.cc. */
  matrixServerName: process.env.MATRIX_SERVER_NAME ?? "localhost",
  /** Optional registration token if the homeserver gates registration. */
  matrixRegistrationToken: process.env.MATRIX_REGISTRATION_TOKEN ?? "",
};
