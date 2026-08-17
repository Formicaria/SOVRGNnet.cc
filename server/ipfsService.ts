import { ENV } from "./_core/env";

/**
 * Server-side IPFS (Kubo) client. Files pin to our own node and serve back
 * through the app — the browser never talks to the IPFS daemon directly,
 * and no third-party gateway is involved.
 */

export class IpfsError extends Error {
  constructor(
    message: string,
    public readonly status?: number
  ) {
    super(message);
    this.name = "IpfsError";
  }
}

type FetchLike = typeof fetch;

let fetchImpl: FetchLike = (...args) => fetch(...args);
export function __setFetchForTests(f: FetchLike): void {
  fetchImpl = f;
}

function apiUrl(path: string): string {
  return `${ENV.ipfsApiUrl.replace(/\/+$/, "")}${path}`;
}

/** Add (and pin) a file. Returns the CID. */
export async function addFile(
  data: Buffer | Uint8Array,
  filename: string
): Promise<string> {
  const form = new FormData();
  form.append("file", new Blob([data as BlobPart]), filename);

  const res = await fetchImpl(apiUrl("/api/v0/add?pin=true&cid-version=1"), {
    method: "POST",
    body: form,
  });

  if (!res.ok) {
    throw new IpfsError(`IPFS add failed (${res.status})`, res.status);
  }

  const text = await res.text();
  // Kubo may return one JSON object per line; the last one is the root.
  const lines = text.trim().split("\n");
  const last = JSON.parse(lines[lines.length - 1]);
  if (!last?.Hash) {
    throw new IpfsError("IPFS add returned no CID");
  }
  return last.Hash as string;
}

/** Read a file's bytes by CID. */
export async function catFile(cid: string): Promise<Buffer> {
  const res = await fetchImpl(
    apiUrl(`/api/v0/cat?arg=${encodeURIComponent(cid)}`),
    { method: "POST" }
  );

  if (!res.ok) {
    throw new IpfsError(`IPFS cat failed (${res.status})`, res.status);
  }
  return Buffer.from(await res.arrayBuffer());
}

/**
 * Unpin a CID, so the node stops keeping it and it can be collected.
 *
 * Exists for one case: an encrypted upload whose key never got published. The
 * ciphertext has to be pinned before the room event carrying its decryption
 * key can be sent, because the CID doesn't exist until the upload finishes —
 * so if that send fails, the node is holding bytes nobody, including the
 * person who uploaded them, will ever be able to read. Keeping them is pure
 * cost with no possible benefit, and leaving them quietly is how a server
 * whose whole point is that you run it yourself fills your disk with garbage
 * you can't identify.
 *
 * Best-effort by design. A CID that was never pinned, or a node that is
 * briefly unreachable, must not turn a cleanup into an error the user sees.
 * The boolean is for logging, not for branching on.
 */
export async function unpinFile(cid: string): Promise<boolean> {
  try {
    const res = await fetchImpl(
      apiUrl(`/api/v0/pin/rm?arg=${encodeURIComponent(cid)}`),
      {
        method: "POST",
      }
    );
    return res.ok;
  } catch {
    return false;
  }
}

export async function isIpfsReachable(): Promise<boolean> {
  try {
    const res = await fetchImpl(apiUrl("/api/v0/version"), { method: "POST" });
    return res.ok;
  } catch {
    return false;
  }
}
