/**
 * Conformance checks for a SOVRGNnet instance.
 *
 * "Anyone can write another implementation" is an aspiration until something
 * can check the claim. This is that something: point it at an address and it
 * answers whether the thing on the other end speaks the protocol.
 *
 * Deliberately pure. The caller does the fetching; this decides. Network code
 * mixed into assertions produces a suite that can only be tested against a live
 * server, which is exactly the kind of thing that rots.
 *
 * Scope is the *protocol surface* only — discovery, versioning, capability
 * negotiation, and self-consistency. It does not test authentication or
 * messaging, which need credentials and would make this something you can't
 * safely run against someone else's instance.
 */

import {
  checkCompatibility,
  parseInstanceDescriptor,
  PROTOCOL_VERSION,
  type InstanceDescriptor,
} from "./protocol";

export type CheckStatus = "pass" | "fail" | "warn" | "skip";

export interface CheckResult {
  id: string;
  title: string;
  status: CheckStatus;
  detail: string;
}

/** One endpoint's response, already fetched. `error` means the request itself
 *  failed — unreachable, TLS refused, timed out. */
export interface Probe {
  ok: boolean;
  status: number;
  /** Parsed JSON body, or null if the body wasn't JSON. */
  body: unknown;
  headers?: Record<string, string>;
  error?: string;
}

export interface Probes {
  instance: Probe;
  capabilities?: Probe;
  version?: Probe;
  health?: Probe;
  ready?: Probe;
  /**
   * `GET <matrix.baseUrl>/_matrix/client/versions`, if the descriptor named a
   * base URL.
   *
   * Second-hop: unlike every other probe it goes to the homeserver rather than
   * the instance, and the caller can only build it after reading the
   * descriptor. Optional because a caller may not be able to make it — but
   * absent is reported as "not checked", never as "fine".
   */
  matrixVersions?: Probe;
}

const pass = (id: string, title: string, detail: string): CheckResult => ({
  id,
  title,
  status: "pass",
  detail,
});
const fail = (id: string, title: string, detail: string): CheckResult => ({
  id,
  title,
  status: "fail",
  detail,
});
const warn = (id: string, title: string, detail: string): CheckResult => ({
  id,
  title,
  status: "warn",
  detail,
});
const skip = (id: string, title: string, detail: string): CheckResult => ({
  id,
  title,
  status: "skip",
  detail,
});

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * Run every check. Order matters for readability: reachability first, then
 * shape, then consistency — because a failure early makes later failures
 * uninformative noise.
 */
export function runConformance(probes: Probes): CheckResult[] {
  const results: CheckResult[] = [];

  // -- Reachability -----------------------------------------------------------

  if (probes.instance.error) {
    results.push(
      fail("reachable", "Instance is reachable", `Couldn't connect: ${probes.instance.error}`)
    );
    return results; // Everything below would just repeat this.
  }

  if (!probes.instance.ok) {
    results.push(
      fail(
        "reachable",
        "Instance is reachable",
        `GET /api/instance returned ${probes.instance.status}. Discovery must be unauthenticated.`
      )
    );
    return results;
  }

  results.push(pass("reachable", "Instance is reachable", "GET /api/instance returned 200"));

  // -- Identity ---------------------------------------------------------------

  const raw = asRecord(probes.instance.body);

  if (!raw) {
    results.push(fail("json", "Descriptor is JSON", "The response body was not a JSON object."));
    return results;
  }
  results.push(pass("json", "Descriptor is JSON", "Parsed as an object"));

  if (raw.product !== "sovrgnnet") {
    results.push(
      fail(
        "product",
        "Identifies as SOVRGNnet",
        `product is ${JSON.stringify(raw.product ?? null)}. A client can't tell this apart ` +
          `from an unrelated service at the same address.`
      )
    );
  } else {
    results.push(pass("product", "Identifies as SOVRGNnet", 'product is "sovrgnnet"'));
  }

  const descriptor = parseInstanceDescriptor(raw);

  if (!descriptor) {
    // "Doesn't match the schema" is a useless thing to tell someone writing a
    // second implementation. Name the likely cause instead.
    results.push(
      fail("descriptor", "Descriptor is valid", diagnoseDescriptor(raw))
    );
    return results;
  }
  results.push(pass("descriptor", "Descriptor is valid", "Matches the schema"));

  // -- Versioning -------------------------------------------------------------

  const compat = checkCompatibility(descriptor.protocol);
  const declared = `${descriptor.protocol.major}.${descriptor.protocol.minor}`;
  const mine = `${PROTOCOL_VERSION.major}.${PROTOCOL_VERSION.minor}`;

  if (compat.ok) {
    results.push(pass("protocol", "Protocol is compatible", `Speaks ${declared}; suite speaks ${mine}`));
  } else {
    results.push(
      fail("protocol", "Protocol is compatible", `Speaks ${declared}; suite speaks ${mine} — ${compat.reason}`)
    );
  }

  results.push(pass("instance-id", "Has a stable identifier", descriptor.server.id));

  // -- Endpoints --------------------------------------------------------------

  results.push(checkCapabilities(probes.capabilities, descriptor));
  results.push(checkVersion(probes.version));
  results.push(checkHealth(probes.health));
  results.push(checkReady(probes.ready));
  results.push(checkCors(probes.instance));

  // -- Self-consistency -------------------------------------------------------

  results.push(...checkConsistency(descriptor, probes.matrixVersions));
  results.push(checkNoLeakage(raw));

  return results;
}

/**
 * Why a descriptor was rejected, in terms someone can act on.
 *
 * Ordered by how often each one is the actual problem when a second
 * implementation is being written against the spec for the first time.
 */
function diagnoseDescriptor(raw: Record<string, unknown>): string {
  const server = asRecord(raw.server);
  const suffix = " See docs/PROTOCOL.md.";

  if (!server) {
    return "No `server` object in the descriptor." + suffix;
  }

  const id = server.id;
  if (typeof id !== "string" || id.length === 0) {
    return "`server.id` is missing." + suffix;
  }
  if (!/^[0-9a-f]{16}$/.test(id)) {
    return (
      `\`server.id\` is "${id}". It must be exactly 16 lowercase hex characters — ` +
      `SHA-256 of "sovrgnnet:instance:<matrix server name>", truncated. The format is ` +
      `normative because the id is the audience of identity tokens, where an ambiguous ` +
      `value is a security problem, not a cosmetic one.` + suffix
    );
  }
  if (typeof server.name !== "string" || server.name.length === 0) {
    return "`server.name` must be a non-empty string." + suffix;
  }
  if (typeof server.version !== "string") {
    return "`server.version` must be a string." + suffix;
  }

  const protocol = asRecord(raw.protocol);
  if (
    !protocol ||
    typeof protocol.major !== "number" ||
    typeof protocol.minor !== "number"
  ) {
    return "`protocol` must be an object with numeric `major` and `minor`." + suffix;
  }

  const matrix = asRecord(raw.matrix);
  if (!matrix || typeof matrix.serverName !== "string") {
    return "`matrix.serverName` must be a string." + suffix;
  }

  if (
    raw.joinPolicy !== undefined &&
    !["open", "invite", "closed"].includes(String(raw.joinPolicy))
  ) {
    return `\`joinPolicy\` is "${String(raw.joinPolicy)}"; expected open, invite, or closed.` + suffix;
  }

  return "The response doesn't match the descriptor schema." + suffix;
}

function checkCapabilities(probe: Probe | undefined, descriptor: InstanceDescriptor): CheckResult {
  const id = "capabilities-endpoint";
  const title = "/api/capabilities agrees with /api/instance";

  if (!probe || probe.error) {
    return warn(id, title, "Not served. Clients must fetch the whole descriptor to poll capabilities.");
  }
  if (!probe.ok) return warn(id, title, `Returned ${probe.status}.`);

  const body = asRecord(probe.body);
  const caps = body ? asRecord(body.capabilities) : null;
  if (!caps) return fail(id, title, "No capabilities object in the response.");

  const disagreements = Object.entries(descriptor.capabilities).filter(
    ([key, value]) => caps[key] !== value
  );

  if (disagreements.length > 0) {
    return fail(
      id,
      title,
      `Disagrees on: ${disagreements.map(([k]) => k).join(", ")}. A client polling the cheap ` +
        `endpoint would see a different instance to one reading the full descriptor.`
    );
  }

  return pass(id, title, "Identical");
}

function checkVersion(probe: Probe | undefined): CheckResult {
  const id = "version-endpoint";
  const title = "/api/version is served";

  if (!probe || probe.error || !probe.ok) {
    return warn(id, title, "Not served. Operators lose an easy way to see what's deployed.");
  }

  const body = asRecord(probe.body);
  if (!body) return fail(id, title, "Response was not a JSON object.");
  if (!body.protocol) return warn(id, title, "No protocol version reported.");

  return pass(id, title, "Reports application and protocol versions");
}

function checkHealth(probe: Probe | undefined): CheckResult {
  const id = "health-endpoint";
  const title = "/health responds without touching the database";

  if (!probe || probe.error) {
    return warn(
      id,
      title,
      "Not served. Nothing distinguishes 'the app is down' from 'the database is down'."
    );
  }

  // A liveness probe that fails when a dependency fails is a readiness probe
  // wearing the wrong name, and it makes orchestrators restart a healthy app.
  if (!probe.ok) {
    return fail(
      id,
      title,
      `Returned ${probe.status}. Liveness must not depend on the database — that's what /ready is for.`
    );
  }

  return pass(id, title, "200");
}

function checkReady(probe: Probe | undefined): CheckResult {
  const id = "ready-endpoint";
  const title = "/ready reports dependencies";

  if (!probe || probe.error) {
    return warn(id, title, "Not served.");
  }

  const body = asRecord(probe.body);
  if (!body) return warn(id, title, `Returned ${probe.status} with no JSON body.`);

  // 503 here is a legitimate answer, not a conformance failure: the endpoint
  // is working correctly and telling the truth about a degraded instance.
  if (!probe.ok) {
    return warn(id, title, `Returned ${probe.status} — the instance says it isn't ready.`);
  }

  return pass(id, title, "200 with per-dependency status");
}

function checkCors(probe: Probe): CheckResult {
  const id = "cors";
  const title = "Discovery allows cross-origin reads";

  const header =
    probe.headers?.["access-control-allow-origin"] ?? probe.headers?.["Access-Control-Allow-Origin"];

  if (!header) {
    return fail(
      id,
      title,
      "No Access-Control-Allow-Origin on /api/instance. A browser-based client can't read " +
        "the descriptor, which makes connecting to this instance impossible from another origin."
    );
  }

  return pass(id, title, `Access-Control-Allow-Origin: ${header}`);
}

/**
 * Cross-field consistency — an instance contradicting itself.
 *
 * These matter more than they look. A descriptor is a set of promises a client
 * acts on; two promises that can't both be true means the client will do
 * something wrong, and the operator will never see why.
 */
function checkConsistency(
  descriptor: InstanceDescriptor,
  /**
   * The homeserver's own response, when the caller was able to fetch it. Every
   * other check here reasons about the descriptor alone; this one needs a
   * second hop, because whether an advertised address works is not something
   * the advertisement can tell you.
   */
  matrixVersions?: Probe
): CheckResult[] {
  const results: CheckResult[] = [];
  const caps = descriptor.capabilities;

  if (caps.publicRegistration && descriptor.joinPolicy !== "open") {
    results.push(
      fail(
        "consistency-registration",
        "Registration claims match the join policy",
        `publicRegistration is true but joinPolicy is "${descriptor.joinPolicy}". ` +
          `Clients will offer a signup form that the instance refuses.`
      )
    );
  } else {
    results.push(
      pass(
        "consistency-registration",
        "Registration claims match the join policy",
        `joinPolicy "${descriptor.joinPolicy}", publicRegistration ${caps.publicRegistration}`
      )
    );
  }

  // Client-side encryption requires two things the instance also advertises
  // separately, and an e2ee claim that contradicts either of them is a claim
  // about a property the deployment structurally cannot have.
  //
  //   clientMatrix — the client reaches the homeserver itself, and can
  //   therefore hold its own keys. Without it the instance proxies everything
  //   and holds the keys, which is not end-to-end encryption under any
  //   description.
  //
  //   eventIngest — the instance records what its homeserver pushes. Without
  //   it an encrypted message never reaches the index, so it is not unreadable
  //   to other members, it is absent.
  //
  // A conforming instance derives e2ee from both (ADR 0011), so this can only
  // fire against one that hard-codes the capability — which is exactly the
  // instance worth catching.
  const missing = [
    !caps.clientMatrix ? "clientMatrix" : null,
    !caps.eventIngest ? "eventIngest" : null,
  ].filter((name): name is string => name !== null);

  if (caps.e2ee && missing.length > 0) {
    results.push(
      fail(
        "consistency-e2ee",
        "Encryption claim is structurally possible",
        `e2ee is true but ${missing.join(" and ")} ${missing.length === 1 ? "is" : "are"} ` +
          "false. This claims a protection the deployment cannot provide."
      )
    );
  } else if (caps.e2ee) {
    results.push(
      pass(
        "consistency-e2ee",
        "Encryption claim is structurally possible",
        "e2ee with clientMatrix and eventIngest"
      )
    );
  } else {
    results.push(
      pass(
        "consistency-e2ee",
        "Encryption claim is structurally possible",
        "e2ee is false — stated honestly"
      )
    );
  }

  if (caps.clientMatrix && !descriptor.matrix.baseUrl) {
    results.push(
      fail(
        "consistency-matrix-url",
        "Direct Matrix access has an address",
        "clientMatrix is true but matrix.baseUrl is null. Clients are told to sync directly " +
          "and given nowhere to sync to."
      )
    );
  } else {
    results.push(
      pass(
        "consistency-matrix-url",
        "Direct Matrix access has an address",
        caps.clientMatrix ? (descriptor.matrix.baseUrl ?? "") : "clientMatrix is false"
      )
    );
  }

  /*
   * Whether that address answers.
   *
   * The check above only asks whether a string is present, and for months this
   * suite passed an instance advertising `http://matrix:8008` — a
   * compose-internal hostname that resolves for the app container and for
   * nothing else. Every Node-based test could be told to ignore the advertised
   * address and used the published port instead, so nothing noticed until a
   * browser tried it and failed every request with "Failed to fetch".
   *
   * An address a client cannot reach is not an address. This performs the
   * first request a real client makes.
   */
  if (!caps.clientMatrix) {
    results.push(
      skip(
        "matrix-reachable",
        "The Matrix address answers",
        "clientMatrix is false — clients are not told to sync directly."
      )
    );
  } else if (!descriptor.matrix.baseUrl) {
    results.push(
      skip(
        "matrix-reachable",
        "The Matrix address answers",
        "No address to try; see the check above."
      )
    );
  } else if (!matrixVersions) {
    // Not "pass". The distinction between "reachable" and "nobody looked" is
    // the entire lesson of this check existing.
    results.push(
      warn(
        "matrix-reachable",
        "The Matrix address answers",
        `Not checked — no probe of ${descriptor.matrix.baseUrl} was supplied. ` +
          "The address is advertised but unverified."
      )
    );
  } else if (matrixVersions.error) {
    results.push(
      fail(
        "matrix-reachable",
        "The Matrix address answers",
        `${descriptor.matrix.baseUrl} is advertised to clients but could not be reached: ` +
          `${matrixVersions.error}. A client told to sync here fails every request. ` +
          "This is usually an address that only resolves inside the deployment."
      )
    );
  } else if (!matrixVersions.ok) {
    results.push(
      fail(
        "matrix-reachable",
        "The Matrix address answers",
        `${descriptor.matrix.baseUrl}/_matrix/client/versions returned ` +
          `HTTP ${matrixVersions.status}. Reachable, but not answering as a homeserver.`
      )
    );
  } else {
    // A 200 from something that isn't a homeserver is still a failure: the
    // body has to carry the one field the endpoint exists to provide.
    const body = matrixVersions.body as { versions?: unknown } | null;
    const versions = Array.isArray(body?.versions) ? body.versions : null;
    if (!versions || versions.length === 0) {
      results.push(
        fail(
          "matrix-reachable",
          "The Matrix address answers",
          `${descriptor.matrix.baseUrl} answered, but not with a Matrix version list. ` +
            "Something is there; it is not a homeserver."
        )
      );
    } else {
      results.push(
        pass(
          "matrix-reachable",
          "The Matrix address answers",
          `${descriptor.matrix.baseUrl} — ${versions.length} spec version(s), latest ${String(versions[versions.length - 1])}`
        )
      );
    }
  }

  if (caps.sso && !descriptor.identityIssuer) {
    results.push(
      fail(
        "consistency-sso",
        "SSO names an issuer",
        "sso is true but identityIssuer is null. Clients have no provider to send anyone to."
      )
    );
  } else {
    results.push(
      pass(
        "consistency-sso",
        "SSO names an issuer",
        caps.sso ? (descriptor.identityIssuer ?? "") : "sso is off"
      )
    );
  }

  if (!caps.messaging) {
    results.push(
      warn(
        "consistency-messaging",
        "Messaging is available",
        "messaging is false. This is a communications server that says it can't communicate."
      )
    );
  } else {
    results.push(pass("consistency-messaging", "Messaging is available", "messaging is true"));
  }

  return results;
}

/**
 * Discovery is unauthenticated, so anything it returns is public to the whole
 * internet. An implementation that helpfully includes the member list has
 * turned a convenience endpoint into a disclosure.
 */
function checkNoLeakage(raw: Record<string, unknown>): CheckResult {
  const id = "no-leakage";
  const title = "Discovery exposes no user or message data";

  const forbidden = [
    "users",
    "members",
    "messages",
    "channels",
    "accounts",
    "emails",
    // Usernames are the sign-in identifier and the Matrix localpart, so a
    // public list of them is worth more to an attacker than the email list
    // this check was originally written to catch: it is a ready-made target
    // list for credential stuffing that also needs no guessing at MXIDs.
    "usernames",
    "servers",
    "communities",
  ];
  const found = forbidden.filter(key => key in raw);

  if (found.length > 0) {
    return fail(
      id,
      title,
      `Unauthenticated /api/instance includes: ${found.join(", ")}. This endpoint is public.`
    );
  }

  const serialized = JSON.stringify(raw);
  if (/"[^"]*@[^"@]+\.[a-z]{2,}"/i.test(serialized) && !/matrix/i.test(serialized.slice(0, 0))) {
    // Matrix IDs look like @user:server and are not email addresses, so only
    // flag things with a dot-suffix TLD after an @ that isn't a Matrix ID.
    const emails = serialized.match(/"[^"@]*@[^"@:]+\.[a-z]{2,}"/gi) ?? [];
    if (emails.length > 0) {
      return warn(
        id,
        title,
        `Possible email address in the public descriptor: ${emails[0]}. Verify this is intentional.`
      );
    }
  }

  return pass(id, title, "No member, message, or channel data");
}

// -- Reporting ----------------------------------------------------------------

export interface ConformanceSummary {
  passed: number;
  failed: number;
  warned: number;
  skipped: number;
  /** Conformant means no failures. Warnings are advice, not violations. */
  conformant: boolean;
}

export function summarize(results: CheckResult[]): ConformanceSummary {
  const count = (s: CheckStatus) => results.filter(r => r.status === s).length;
  const failed = count("fail");
  return {
    passed: count("pass"),
    failed,
    warned: count("warn"),
    skipped: count("skip"),
    conformant: failed === 0,
  };
}

export { skip };
