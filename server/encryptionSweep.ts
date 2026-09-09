import * as db from "./db";
import { e2eeAvailable } from "./instance";
import * as matrix from "./matrixService";

/**
 * Encrypt every channel that predates always-on encryption — ADR 0015.
 *
 * Until that decision a channel was born plaintext on any instance that
 * couldn't encrypt at the moment of creation, which was every desktop host
 * and every Docker install whose operator hadn't wired the appservice by
 * hand. Those channels exist. Their rooms carry no `m.room.encryption`, their
 * rows say `encrypted: false`, and every message sent into them is composed
 * server-side in the clear.
 *
 * This turns each of them on, once, the same way the admin switch did: the
 * state event, set by an account with the power to set it, and the index
 * marked so the client refuses plaintext into the room from that moment. It
 * runs on the same interval as the reachability probe and does nothing until
 * `e2eeAvailable()` is true — which on a fresh start is a few seconds after
 * the homeserver answers — and then does nothing again once a pass finds no
 * plaintext channel left. A failure on one room is logged and left for the
 * next pass; it is not a reason to stop encrypting the others.
 *
 * What it does not do: touch messages already written. They were plaintext
 * on disk for their whole life and re-writing them as ciphertext would
 * protect them from an attacker who arrives after the sweep and nobody else,
 * while making them unreadable to any member whose keys rotated since. The
 * boundary is marked in the interface instead of painted over.
 *
 * Whose session sets the state: the community owner's. The instance created
 * the room with that account's server-held session and gave it the power
 * levels, so it is the one session guaranteed able to change the room. The
 * instance's own service user is invited to nothing and could not.
 */

/** Set once a pass finds nothing left, so a healthy instance stops asking. */
let finished = false;

export function __resetSweepForTests(): void {
  finished = false;
}

export interface SweepResult {
  /** Channels the sweep encrypted this pass. */
  encrypted: number;
  /** Channels it tried and could not — logged, left for the next pass. */
  failed: number;
  /** Why nothing happened, when nothing happened. */
  skipped?: "finished" | "e2ee-unavailable";
}

export async function sweepPlaintextChannels(): Promise<SweepResult> {
  if (finished) return { encrypted: 0, failed: 0, skipped: "finished" };
  if (!e2eeAvailable()) return { encrypted: 0, failed: 0, skipped: "e2ee-unavailable" };

  const pending = await db.listPlaintextChannels();
  if (pending.length === 0) {
    finished = true;
    return { encrypted: 0, failed: 0 };
  }

  let encrypted = 0;
  let failed = 0;
  for (const channel of pending) {
    try {
      const owner = await db.getMatrixCredentials(channel.ownerId);
      if (!owner) {
        // An owner with no Matrix session has never opened the community —
        // a room nobody has entered. It will be encrypted when they do, by
        // the next pass; there is no one to act as until then.
        failed += 1;
        continue;
      }
      await matrix.enableRoomEncryption(owner.accessToken, channel.matrixRoomId);
      // The appservice will mark it too when the homeserver pushes the state
      // event back; marking here as well makes the change visible now and is
      // idempotent, exactly as the admin switch reasoned.
      await db.markChannelEncrypted(channel.matrixRoomId);
      encrypted += 1;
    } catch (error) {
      failed += 1;
      console.warn(
        `[encryption] couldn't encrypt channel ${channel.id} (${channel.matrixRoomId}) this pass:`,
        error instanceof Error ? error.message : error
      );
    }
  }

  if (encrypted > 0) {
    console.log(
      `[encryption] encrypted ${encrypted} channel(s) that predated always-on encryption` +
        (failed > 0 ? `; ${failed} left for the next pass` : "")
    );
  }
  if (failed === 0) finished = true;
  return { encrypted, failed };
}
