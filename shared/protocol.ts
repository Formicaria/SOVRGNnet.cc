import { z } from "zod";

/**
 * The SOVRGN protocol — the interoperability layer between any client and any
 * instance.
 *
 * This is deliberately separate from application versioning. An instance
 * running 0.4.0 and a client running 0.6.0 must interoperate if they speak the
 * same protocol major version, because independently operated servers do not
 * upgrade in lockstep with anybody's release schedule. Requiring them to would
 * make every instance quietly dependent on the project's cadence, which is the
 * thing this architecture exists to avoid.
 *
 * The PostgreSQL schema is implementation state. *This* is the contract.
 */

/**
 * Protocol version.
 *
 * Major changes break compatibility: a client that speaks major 1 cannot talk
 * to an instance that speaks only major 2. Minor changes add capabilities and
 * are always backward compatible — an older client simply won't ask for the
 * new things.
 */
export const PROTOCOL_VERSION = { major: 1, minor: 0 } as const;

export const protocolVersionSchema = z.object({
  major: z.number().int().nonnegative(),
  minor: z.number().int().nonnegative(),
});
export type ProtocolVersion = z.infer<typeof protocolVersionSchema>;

/**
 * What an instance can do.
 *
 * Every capability defaults to **false**. That direction matters: an older
 * instance that has never heard of a capability must read as "doesn't have
 * it", never as "probably fine". Optimistic defaults are how a client ends up
 * offering a feature that silently does nothing.
 */
export const capabilitiesSchema = z.object({
  /** Text messaging. The one thing every instance has. */
  messaging: z.boolean().default(true),
  /** File sharing through the instance's own storage. */
  media: z.boolean().default(false),
  /** End-to-end encryption. False until keys genuinely live on devices. */
  e2ee: z.boolean().default(false),
  /** Voice and video channels. */
  voice: z.boolean().default(false),
  /** Whether this homeserver talks to other Matrix servers. */
  federation: z.boolean().default(false),
  /** Whether this instance accepts identities from an identity provider. */
  sso: z.boolean().default(false),
  /** Whether anyone may create an account without an invite. */
  publicRegistration: z.boolean().default(false),
  /** Whether the client may talk to Matrix directly rather than via the app. */
  clientMatrix: z.boolean().default(false),
  /** Whether this instance can produce and consume portable backups. */
  portableBackup: z.boolean().default(false),
});
export type Capabilities = z.infer<typeof capabilitiesSchema>;
export type CapabilityName = keyof Capabilities;

/**
 * What an instance says about itself, to anyone who asks.
 *
 * Deliberately free of anything private: no member counts, no channel lists,
 * no user data. A stranger fetching this learns what the software can do and
 * whether they may join — nothing about who is already there.
 */
export const instanceDescriptorSchema = z.object({
  /** Confirms this is a SOVRGNnet instance and not something else entirely. */
  product: z.literal("sovrgnnet"),
  protocol: protocolVersionSchema,
  server: z.object({
    /** Application version. Informational — never used for compatibility. */
    version: z.string(),
    /** Stable, non-secret identifier for this instance. */
    id: z.string().regex(/^[0-9a-f]{16}$/),
    name: z.string().min(1).max(120),
    description: z.string().max(500).nullable().default(null),
  }),
  capabilities: capabilitiesSchema,
  matrix: z.object({
    /** The domain in Matrix IDs. Permanent for the life of the instance. */
    serverName: z.string(),
    /** Public homeserver URL, when clients may reach it directly. */
    baseUrl: z.string().url().nullable().default(null),
  }),
  /** open = anyone · invite = invite required · closed = nobody */
  joinPolicy: z.enum(["open", "invite", "closed"]).default("invite"),
  /** Where identities come from, if this instance accepts external ones. */
  identityIssuer: z.string().url().nullable().default(null),
});
export type InstanceDescriptor = z.infer<typeof instanceDescriptorSchema>;

// -------------------------------------------------------------- compatibility

export type Compatibility =
  | { ok: true; protocol: ProtocolVersion }
  | { ok: false; reason: "client-too-old" | "server-too-old" | "not-sovrgnnet"; message: string };

/**
 * Can this client talk to this instance?
 *
 * Same major version is the whole test. A newer minor on either side is fine:
 * the older party doesn't know about the additions and won't ask for them.
 */
export function checkCompatibility(
  instance: ProtocolVersion,
  client: ProtocolVersion = PROTOCOL_VERSION
): Compatibility {
  if (instance.major > client.major) {
    return {
      ok: false,
      reason: "client-too-old",
      message:
        "This instance speaks a newer version of the SOVRGN protocol. Update your client to connect.",
    };
  }
  if (instance.major < client.major) {
    return {
      ok: false,
      reason: "server-too-old",
      message:
        "This instance speaks an older version of the SOVRGN protocol. Its operator needs to update it.",
    };
  }
  return { ok: true, protocol: instance };
}

/**
 * Parse whatever an instance returned.
 *
 * Anything unrecognisable is "not-sovrgnnet" rather than an exception, because
 * pointing a client at the wrong address is an ordinary thing people do, not
 * an exceptional condition.
 */
export function parseInstanceDescriptor(raw: unknown): InstanceDescriptor | null {
  const parsed = instanceDescriptorSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

/**
 * Ask whether an instance supports something.
 *
 * Always route capability questions through here rather than reading the flag
 * directly: a descriptor from an older instance may not carry the field at
 * all, and this treats missing as absent.
 */
export function supports(
  descriptor: Pick<InstanceDescriptor, "capabilities">,
  capability: CapabilityName
): boolean {
  return descriptor.capabilities?.[capability] === true;
}

/**
 * Why a feature is unavailable, in words for a person.
 *
 * Graceful degradation means explaining, not hiding. Someone whose friend's
 * instance has no voice should learn that, not wonder where the button went.
 */
export function explainMissing(capability: CapabilityName): string {
  const reasons: Record<CapabilityName, string> = {
    messaging: "This instance doesn't support messaging, which is unusual — it may be misconfigured.",
    media: "This instance doesn't have file sharing switched on.",
    e2ee: "This instance doesn't support end-to-end encryption yet. Messages are readable by whoever runs it.",
    voice: "This instance doesn't have voice channels.",
    federation: "This instance doesn't talk to other Matrix servers.",
    sso: "This instance only accepts accounts created on it directly.",
    publicRegistration: "This instance is invite-only.",
    clientMatrix: "This instance routes messages through its own server rather than letting clients connect to Matrix directly.",
    portableBackup: "This instance doesn't support portable backups.",
  };
  return reasons[capability];
}
