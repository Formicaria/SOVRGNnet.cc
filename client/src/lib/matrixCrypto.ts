/**
 * The crypto machine — ADR 0008 stage 4.
 *
 * Stage 3 shipped a hand-rolled /sync engine and said matrix-js-sdk would earn
 * its place when encryption arrived. It has. Olm and Megolm are not code this
 * project should be writing: the interesting risk in a chat application is
 * whether a room key reaches the right devices, not whether an AES round is
 * correct, and every hour spent on the second is an hour not spent on the
 * first. So the SDK owns the Matrix session now — one session, not two — and
 * this module owns everything around it that is a *decision*.
 *
 * Three things here are worth reading before changing anything:
 *
 * **The crypto store persists; the access token does not.** Stage 3 kept the
 * token in memory on purpose and that has not changed — a reload re-mints one
 * over the authenticated instance API. But the Megolm inbound sessions must
 * survive a reload, because they are the only copy of the ability to read
 * messages already received. A crypto store that resets on refresh would turn
 * every reload into permanent history loss. So keys live in IndexedDB, and
 * that has a consequence written down in the threat model: anything with
 * access to the browser profile can read them.
 *
 * **Cross-signing setup goes through the instance, and not because it's
 * convenient.** See `authUploadDeviceSigningKeys` below.
 *
 * **Nothing here is loaded unless it is used.** The whole module — SDK, WASM,
 * crypto store — is behind a dynamic import in `useMatrixSession`, so an
 * instance that doesn't advertise `clientMatrix` never fetches a byte of it.
 */

import {
  createClient,
  ClientEvent,
  MatrixEventEvent,
  MemoryStore,
  RoomEvent,
  SyncState,
  type AuthDict,
  type MatrixClient,
  type MatrixEvent,
  type Room,
} from "matrix-js-sdk";
import {
  CryptoEvent,
  type CryptoApi,
  type GeneratedSecretStorageKey,
} from "matrix-js-sdk/lib/crypto-api/index.js";
import { decodeRecoveryKey } from "matrix-js-sdk/lib/crypto-api/recovery-key.js";
import {
  VerificationPhase,
  VerifierEvent,
  type ShowSasCallbacks,
  type VerificationRequest,
} from "matrix-js-sdk/lib/crypto-api/verification.js";
import {
  ATTACHMENT_EVENT_KEY,
  readAttachment,
  type EncryptedAttachment,
} from "@shared/attachments";
import {
  describeDecryptionFailure,
  describeReadiness,
  formatRecoveryKey,
  type CryptoReadiness,
  type DecryptionVerdict,
  type ReadinessVerdict,
} from "@shared/e2ee";

/** What the client tells the room about a file it just uploaded. */
export interface FileAnnouncement {
  filename: string;
  cid: string;
  size: number;
  mimeType?: string | null;
  /** Absent when the channel is plaintext and the bytes went up as-is. */
  encryption?: EncryptedAttachment;
}

/** What the UI needs to know about one message the index told us exists. */
export interface DecryptedMessage {
  eventId: string;
  roomId: string;
  sender: string;
  body: string;
  verdict: DecryptionVerdict;
}

export interface DeviceEntry {
  deviceId: string;
  displayName: string | null;
  /** Signed by this account's cross-signing identity. */
  verified: boolean;
  isOwnDevice: boolean;
}

export interface SasPrompt {
  /** Emoji pairs, as [glyph, name]. Empty when the method isn't emoji SAS. */
  emoji: Array<[string, string]>;
  confirm(): Promise<void>;
  mismatch(): void;
  cancel(): void;
}

export interface StartOptions {
  homeserverUrl: string;
  userId: string;
  accessToken: string;
  deviceId: string;
  /**
   * Completes the user-interactive-auth password stage for a device-signing
   * upload, server-side. See `bootstrapEncryption`.
   */
  completeCrossSigningAuth: (session: string) => Promise<void>;
  /** Something the UI renders has changed. Coalesced by the caller. */
  onChange: () => void;
  /** An incoming verification request needs a decision from the user. */
  onVerificationRequest: (request: VerificationRequest) => void;
  /** Every room timeline event, in the shape stage 3's engine emitted. */
  onTimelineEvent: (event: TimelineNotice) => void;
  /**
   * Persist the crypto store. True in a browser, and it must be — Megolm
   * inbound sessions are the only copy of the ability to read messages already
   * received, so a store that resets on refresh makes every reload permanent
   * history loss.
   *
   * The only caller that passes false is the end-to-end harness, which runs
   * this module in Node where there is no IndexedDB. That is the point of the
   * option: it lets the harness exercise *this* code — the real session, the
   * real Olm, the real key sharing — rather than a reimplementation of it that
   * could pass while the shipped path is broken.
   */
  persistCryptoStore?: boolean;
}

/**
 * The liveness signal, unchanged from stage 3 except for one absence: there is
 * no `content`. In an encrypted room the wire type is `m.room.encrypted` and
 * there is nothing readable in the envelope, which is the point — so nothing
 * downstream may branch on content, and this shape makes that impossible
 * rather than merely discouraged.
 */
export interface TimelineNotice {
  roomId: string;
  type: string;
  eventId: string;
  sender: string;
  originServerTs: number;
}

export interface CryptoSession {
  readonly client: MatrixClient;
  readonly userId: string;
  readonly deviceId: string;
  /** Plaintext for an event id the instance index reported, if we have it. */
  lookup(eventId: string): DecryptedMessage | undefined;
  /**
   * The decryption key for an uploaded file, read off the encrypted event that
   * announced it. Undefined until that event has reached this device — which
   * is the same "waiting for the key" state messages have, for the same
   * reason.
   */
  attachmentFor(cid: string): EncryptedAttachment | null | undefined;
  /** Announce an upload in the room, with the file's key inside the event. */
  sendFile(roomId: string, file: FileAnnouncement): Promise<string>;
  /** Pull older timeline for a room so its encrypted history can decrypt. */
  backfill(roomId: string, limit?: number): Promise<void>;
  send(roomId: string, body: string): Promise<string>;
  readiness(): Promise<CryptoReadiness & { verdict: ReadinessVerdict }>;
  /** First-time setup: cross-signing, secret storage, key backup. */
  bootstrapEncryption(): Promise<{ recoveryKey: string }>;
  /** This device, using a recovery key the user still has. */
  recoverWithKey(
    recoveryKey: string
  ): Promise<{ imported: number; total: number }>;
  listDevices(): Promise<DeviceEntry[]>;
  /** Ask another of this user's devices to verify this one. */
  requestOwnVerification(): Promise<VerificationRequest>;
  /** Drive a request to emoji, whichever side started it. */
  sasFor(request: VerificationRequest): Promise<SasPrompt>;
  stop(): Promise<void>;
}

/**
 * The rust crypto store lives in IndexedDB under a name derived from the
 * account, so two people using the same browser profile never share one.
 *
 * Note what this does *not* do: encrypt the store. The browser has no keychain
 * to hold a store passphrase, so the only places to keep one are somewhere the
 * same attacker can read, or the user's head — and prompting for a passphrase
 * on every page load is a feature nobody would keep enabled. The honest
 * position is an unencrypted store and a threat model that says so (T21),
 * rather than a passphrase that rounds to obfuscation.
 */
function cryptoStorePrefix(userId: string): string {
  // Colons and slashes are legal in a Matrix ID and awkward in a database
  // name; the substitution only needs to be injective, not pretty.
  return `sovrgn-crypto-${userId.replace(/[^a-zA-Z0-9]/g, "_")}`;
}

/** Reads the UIA session id out of a 401 the way the spec describes it. */
function uiaSession(err: unknown): string | null {
  const data = (
    err as { data?: { session?: unknown }; httpStatus?: number } | null
  )?.data;
  const session = data?.session;
  return typeof session === "string" && session ? session : null;
}

export async function startCryptoSession(
  opts: StartOptions
): Promise<CryptoSession> {
  /**
   * Secret storage keys live here and only here — in memory, for the lifetime
   * of the tab. A recovery key written to localStorage would be a recovery key
   * that any script on the page can read, which defeats the reason it exists:
   * it is the one secret that survives losing every device, so it is the one
   * secret that must never be sitting somewhere a compromised page can take.
   */
  const secretStorageKeys = new Map<string, Uint8Array<ArrayBuffer>>();

  const client = createClient({
    baseUrl: opts.homeserverUrl,
    accessToken: opts.accessToken,
    userId: opts.userId,
    deviceId: opts.deviceId,
    // Sync state is not persisted: message history comes from the instance
    // index, and for encrypted rooms it is re-paginated on demand. Only the
    // crypto store has to survive a reload, and it does.
    store: new MemoryStore(),
    // QR and reciprocation need a camera and a second screen; emoji needs
    // neither and works between two browser tabs, which is the case people
    // actually hit. Listed explicitly so adding one is a decision.
    verificationMethods: ["m.sas.v1"],
    cryptoCallbacks: {
      getSecretStorageKey: async ({ keys }) => {
        const defaultKeyId = await client.secretStorage.getDefaultKeyId();
        // Prefer the account's default key; fall back to any key we hold,
        // because a client that refuses a key it has is a client that asks
        // the user to re-enter a key it is already holding.
        const candidates =
          defaultKeyId && keys[defaultKeyId]
            ? [defaultKeyId]
            : Object.keys(keys);
        for (const keyId of candidates) {
          const key = secretStorageKeys.get(keyId);
          if (key) return [keyId, key];
        }
        return null;
      },
      cacheSecretStorageKey: (keyId, _info, key) => {
        secretStorageKeys.set(keyId, key);
      },
    },
  });

  await client.initRustCrypto({
    useIndexedDB: opts.persistCryptoStore !== false,
    cryptoDatabasePrefix: cryptoStorePrefix(opts.userId),
  });

  const crypto = client.getCrypto();
  if (!crypto) {
    // initRustCrypto resolving without a crypto API would mean the WASM loaded
    // and then produced nothing. Refusing here is better than running an
    // apparently-working session that silently sends plaintext.
    throw new Error("Crypto initialised but no crypto API is available");
  }

  /**
   * Room keys go to cross-signed devices and nowhere else.
   *
   * This is the setting that decides what ADR 0008 called the difference
   * between a passive and an active operator. An instance can mint a Matrix
   * device for any user whenever it likes — the derived password guarantees
   * that — and under the SDK's default the minted device receives room keys
   * like any other, with a warning as the only protection. Withholding them
   * means it gets nothing until a real device belonging to that user signs it,
   * which is an action a person has to take and can refuse.
   *
   * **Two settings, doing different jobs, and it is easy to set the wrong
   * one.** `globalBlacklistUnverifiedDevices` is what actually withholds keys;
   * it defaults to false. `setTrustCrossSignedDevices` decides what counts as
   * verified — with it on, a device its owner has cross-signed qualifies, so
   * people verify each of their own devices once rather than verifying every
   * device of every person they talk to. Setting only the second one changes a
   * shield icon and sends the keys anyway.
   *
   * The cost is real and is not hidden: an unverified device of your own reads
   * nothing until you verify it, and someone who verifies nothing sees holes.
   * That cost is what buys the property the whole stage exists for.
   */
  crypto.globalBlacklistUnverifiedDevices = true;
  crypto.setTrustCrossSignedDevices(true);

  // ── decrypted message index ────────────────────────────────────────────────
  //
  // The instance's index stores `m.room.encrypted` rows content-blind (ADR
  // 0009), which is correct and leaves it unable to render a word of an
  // encrypted room. So the plaintext has to come from here. This map is the
  // join: index rows carry the event id, and this is event id → plaintext.

  const decrypted = new Map<string, DecryptedMessage>();

  // cid → the key that opens those bytes, harvested from decrypted file
  // events. The instance's file list supplies the cid, size and filename; only
  // this supplies the means to read the contents, and only on a device the
  // room key reached.
  const attachments = new Map<string, EncryptedAttachment | null>();

  function record(event: MatrixEvent): void {
    if (event.getType() !== "m.room.message" && !event.isEncrypted()) return;
    const eventId = event.getId();
    const roomId = event.getRoomId();
    const sender = event.getSender();
    if (!eventId || !roomId || !sender) return;

    const attachment = readAttachment(event.getContent());
    if (attachment) attachments.set(attachment.cid, attachment.encryption);

    const failure = event.isDecryptionFailure()
      ? event.decryptionFailureReason
      : null;
    const verdict = event.isEncrypted()
      ? describeDecryptionFailure(failure)
      : { state: "plaintext" as const, detail: "" };

    const content = event.getContent();
    const body = typeof content?.body === "string" ? content.body : "";

    decrypted.set(eventId, { eventId, roomId, sender, body, verdict });
    opts.onChange();
  }

  const onTimeline = (event: MatrixEvent, _room: Room | undefined) => {
    record(event);

    // An event can arrive still-encrypted and decrypt a moment later, so the
    // Decrypted handler is attached per event as we see it. Doing it here
    // rather than in a global listener is what catches the ones that arrive
    // during a backfill, which is most of them in an encrypted room.
    if (event.isEncrypted()) {
      event.once(MatrixEventEvent.Decrypted, () => record(event));
    }

    // Forwarded in the shape the dashboard already consumes, so "something
    // happened in room X, go refetch" keeps working exactly as it did in
    // stage 3. Attached here rather than by the caller so it comes off again
    // in `stop()` along with everything else.
    const roomId = event.getRoomId();
    const eventId = event.getId();
    const sender = event.getSender();
    if (roomId && eventId && sender) {
      opts.onTimelineEvent({
        roomId,
        eventId,
        sender,
        type: event.getType(),
        originServerTs: event.getTs(),
      });
    }
  };

  client.on(RoomEvent.Timeline, onTimeline);

  // A room key arriving retroactively unlocks messages already on screen. The
  // SDK re-decrypts them and fires Decrypted per event, which `onTimeline`
  // already covers — but only for events we saw. Re-walking the room's live
  // timeline on a key import catches the rest.
  const onKeysImported = () => {
    for (const room of client.getRooms()) {
      for (const event of room.getLiveTimeline().getEvents()) record(event);
    }
  };
  client.on(CryptoEvent.KeysChanged, onKeysImported);
  client.on(CryptoEvent.KeyBackupDecryptionKeyCached, onKeysImported);

  const onVerificationRequest = (request: VerificationRequest) => {
    if (request.phase === VerificationPhase.Requested)
      opts.onVerificationRequest(request);
  };
  client.on(CryptoEvent.VerificationRequestReceived, onVerificationRequest);

  const onSync = (state: SyncState) => {
    if (state === SyncState.Prepared || state === SyncState.Syncing)
      opts.onChange();
  };
  client.on(ClientEvent.Sync, onSync);

  const onDevicesUpdated = () => opts.onChange();
  client.on(CryptoEvent.DevicesUpdated, onDevicesUpdated);
  client.on(CryptoEvent.KeyBackupStatus, onDevicesUpdated);

  await client.startClient({ initialSyncLimit: 20 });

  // ── the UIA problem, and what this does about it ───────────────────────────
  //
  // Uploading cross-signing keys is user-interactive-auth gated: the
  // homeserver wants the account password before it will accept a new identity
  // for the account. This instance's Matrix passwords are derived
  // (`deriveMatrixPassword`), so the instance knows every one of them and the
  // browser knows none.
  //
  // The easy version is to have the instance hand the derived password to the
  // client for the duration of the flow. That is a bad trade: the password is
  // permanent and unrotatable, it authorises everything, and putting it in a
  // browser puts it within reach of any XSS this app ever has.
  //
  // So instead the browser completes the flow *without* it. UIA stages are
  // completed against a session id, not against a request body — that is why
  // the SSO stage can be satisfied in a different window. The client makes the
  // request, gets a 401 with a session, asks the instance to satisfy the
  // password stage for that session, then re-submits carrying only the session
  // id. The private cross-signing keys never leave the browser and the
  // password never enters it.
  //
  // What the instance can do in that window is upload cross-signing keys of
  // its own instead. It cannot do so invisibly: a master key change is
  // published to every device of every user who has verified this account, and
  // is exactly what the verification warnings exist to report. That is the
  // same residual risk ADR 0008 named for device minting, and it is resolved
  // by removing the derived password, which is its own ADR.
  const authUploadDeviceSigningKeys = async <T>(
    makeRequest: (auth: AuthDict | null) => Promise<T>
  ): Promise<T> => {
    try {
      return await makeRequest(null);
    } catch (err) {
      const session = uiaSession(err);
      if (!session) throw err;
      await opts.completeCrossSigningAuth(session);
      return await makeRequest({ session } as AuthDict);
    }
  };

  // An arrow const rather than a function declaration, so TypeScript keeps the
  // `crypto` narrowing from the throw above instead of assuming a hoisted
  // declaration might run before it.
  const readiness = async (): Promise<
    CryptoReadiness & { verdict: ReadinessVerdict }
  > => {
    const [crossSigningReady, secretStorageReady, activeBackup, deviceStatus] =
      await Promise.all([
        crypto.isCrossSigningReady(),
        crypto.isSecretStorageReady(),
        crypto.getActiveSessionBackupVersion(),
        crypto.getDeviceVerificationStatus(opts.userId, opts.deviceId),
      ]);

    const state: CryptoReadiness = {
      crossSigningReady,
      secretStorageReady,
      keyBackupEnabled: activeBackup !== null,
      deviceVerified: deviceStatus?.crossSigningVerified === true,
    };
    return { ...state, verdict: describeReadiness(state) };
  };

  return {
    client,
    userId: opts.userId,
    deviceId: opts.deviceId,

    lookup(eventId) {
      return decrypted.get(eventId);
    },

    attachmentFor(cid) {
      return attachments.get(cid);
    },

    async sendFile(roomId, file) {
      // Same send path as a message, so the SDK encrypts it if the room is
      // encrypted — which is what puts the file's key beyond the instance's
      // reach. Composing this event without encryption would publish the key
      // next to the ciphertext it opens.
      const result = await client.sendEvent(
        roomId,
        "m.room.message" as never,
        {
          msgtype: "m.file",
          body: file.filename,
          [ATTACHMENT_EVENT_KEY]: {
            cid: file.cid,
            size: file.size,
            ...(file.mimeType ? { mimeType: file.mimeType } : {}),
            ...(file.encryption ? { encryption: file.encryption } : {}),
          },
        } as never
      );
      return result.event_id;
    },

    async backfill(roomId, limit = 50) {
      const room = client.getRoom(roomId);
      if (!room) return;
      await client.scrollback(room, limit);
      for (const event of room.getLiveTimeline().getEvents()) record(event);
    },

    async send(roomId, body) {
      // No branch on whether the room is encrypted. The SDK reads
      // `m.room.encryption` from room state and encrypts or doesn't — and a
      // client that decided for itself would be a client that can get it
      // wrong in the direction that matters.
      const result = await client.sendEvent(
        roomId,
        "m.room.message" as never,
        {
          msgtype: "m.text",
          body,
        } as never
      );
      return result.event_id;
    },

    readiness,

    async bootstrapEncryption() {
      let generated: GeneratedSecretStorageKey | null = null;

      await crypto.bootstrapCrossSigning({ authUploadDeviceSigningKeys });

      await crypto.bootstrapSecretStorage({
        setupNewKeyBackup: true,
        createSecretStorageKey: async () => {
          generated = await crypto.createRecoveryKeyFromPassphrase();
          return generated;
        },
      });

      // Bootstrap only creates a new key when there isn't one. If secret
      // storage already existed, there is no key to show and saying "here is
      // your recovery key" would be a lie about a key the user still needs to
      // find.
      const key = (generated as GeneratedSecretStorageKey | null)
        ?.encodedPrivateKey;
      if (!key) {
        throw new Error(
          "This account already has a recovery key. Use it to verify this device instead."
        );
      }

      await crypto.checkKeyBackupAndEnable();
      opts.onChange();
      return { recoveryKey: formatRecoveryKey(key) };
    },

    async recoverWithKey(recoveryKey) {
      const privateKey = decodeRecoveryKey(recoveryKey);
      const keyId = await client.secretStorage.getDefaultKeyId();
      if (!keyId) throw new Error("This account has no recovery key set up.");

      const description = await client.secretStorage.getKey(keyId);
      if (!description)
        throw new Error("This account has no recovery key set up.");

      const matches = await client.secretStorage.checkKey(
        privateKey,
        description[1]
      );
      // Checked before caching, so a wrong key fails here with a sentence the
      // user can act on rather than three screens later as a decryption error.
      if (!matches)
        throw new Error("That recovery key doesn't match this account.");

      secretStorageKeys.set(keyId, privateKey);

      // Cross-signing secrets come out of storage first: they are what make
      // this device trusted, and an untrusted device restoring a backup is a
      // device that still won't be sent new keys.
      await crypto.bootstrapCrossSigning({ authUploadDeviceSigningKeys });
      await crypto.loadSessionBackupPrivateKeyFromSecretStorage();
      await crypto.checkKeyBackupAndEnable();

      const result = await crypto.restoreKeyBackup();
      onKeysImported();
      opts.onChange();
      return { imported: result.imported, total: result.total };
    },

    async listDevices() {
      const map = await crypto.getUserDeviceInfo([opts.userId], true);
      const devices = map.get(opts.userId);
      if (!devices) return [];

      const entries: DeviceEntry[] = [];
      for (const [deviceId, device] of Array.from(devices.entries())) {
        const status = await crypto.getDeviceVerificationStatus(
          opts.userId,
          deviceId
        );
        entries.push({
          deviceId,
          displayName: device.displayName ?? null,
          verified: status?.crossSigningVerified === true,
          isOwnDevice: deviceId === opts.deviceId,
        });
      }
      // Unverified first: the list exists so somebody notices an unexpected
      // device, and sorting it by name would bury the one that matters.
      return entries.sort((a, b) => Number(a.verified) - Number(b.verified));
    },

    async requestOwnVerification() {
      return await crypto.requestOwnUserVerification();
    },

    async sasFor(request) {
      if (
        request.phase === VerificationPhase.Requested &&
        !request.initiatedByMe
      ) {
        await request.accept();
      }

      const verifier =
        request.verifier ?? (await request.startVerification("m.sas.v1"));

      const sas = await new Promise<ShowSasCallbacks>((resolve, reject) => {
        const existing = verifier.getShowSasCallbacks();
        if (existing) return resolve(existing);
        verifier.once(VerifierEvent.ShowSas, resolve);
        // The verifier's own promise rejects on cancellation from either side;
        // without this the dialog would sit on emoji that will never arrive.
        verifier.verify().catch(reject);
      });

      return {
        emoji: (sas.sas.emoji ?? []) as Array<[string, string]>,
        confirm: () => sas.confirm(),
        mismatch: () => sas.mismatch(),
        cancel: () => sas.cancel(),
      };
    },

    async stop() {
      client.off(RoomEvent.Timeline, onTimeline);
      client.off(CryptoEvent.KeysChanged, onKeysImported);
      client.off(CryptoEvent.KeyBackupDecryptionKeyCached, onKeysImported);
      client.off(
        CryptoEvent.VerificationRequestReceived,
        onVerificationRequest
      );
      client.off(CryptoEvent.DevicesUpdated, onDevicesUpdated);
      client.off(CryptoEvent.KeyBackupStatus, onDevicesUpdated);
      client.off(ClientEvent.Sync, onSync);
      // Tears down the crypto backend too — `stopClient` stops the WASM
      // machine before it checks whether the client was even running, which
      // is what stops a hot reload stacking a second machine on the same
      // IndexedDB store.
      client.stopClient();
      secretStorageKeys.clear();
      attachments.clear();
    },
  };
}

export type { CryptoApi, VerificationRequest };
