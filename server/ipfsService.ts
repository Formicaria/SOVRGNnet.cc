import { ENV } from "./_core/env";

/**
 * Server-side IPFS (Kubo) client. Files pin to our own node and serve back
 * through the app — the browser never talks to the IPFS daemon directly,
 * and no third-party gateway is involved.
 */

export class IpfsError extends Error {
  constructor(message: string, public readonly status?: number) {
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

export async function isIpfsReachable(): Promise<boolean> {
  try {
    const res = await fetchImpl(apiUrl("/api/v0/version"), { method: "POST" });
    return res.ok;
  } catch {
    return false;
  }
}
