import { useEffect, useState } from "react";
import { AlertTriangle, Download, Loader2, Lock } from "lucide-react";
import {
  AttachmentError,
  decryptAttachment,
  type EncryptedAttachment,
} from "@shared/attachments";

/**
 * One shared file, in a channel that may or may not be encrypted.
 *
 * In a plaintext channel the browser fetches `/api/files/:cid` directly, as it
 * always has. In an encrypted one those bytes are ciphertext and the key came
 * in the room event — so the fetch, the hash check and the decryption happen
 * here, and what reaches an `<img>` or a download link is a blob URL for
 * plaintext that never left this device in the clear.
 *
 * Three states, and the third is the one worth getting right: a file whose
 * announcing event hasn't reached this device yet is not broken and not
 * missing. It says so, and resolves itself when the room key arrives — the
 * same shape as a message waiting on a key, because it is the same problem.
 */

interface Props {
  cid: string;
  filename: string;
  fileSize: number;
  mimeType: string | null;
  /**
   * `null` — announced as unencrypted, fetch it directly.
   * `undefined` — no announcement has arrived yet.
   */
  encryption: EncryptedAttachment | null | undefined;
  formatBytes: (bytes: number) => string;
}

export function SharedFile({
  cid,
  filename,
  fileSize,
  mimeType,
  encryption,
  formatBytes,
}: Props) {
  const [objectUrl, setObjectUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!encryption) return;

    let revoked = false;
    let url: string | null = null;

    (async () => {
      try {
        const response = await fetch(`/api/files/${cid}`, {
          credentials: "include",
        });
        if (!response.ok)
          throw new Error(`Couldn't fetch this file (${response.status}).`);

        const ciphertext = new Uint8Array<ArrayBuffer>(
          await response.arrayBuffer()
        );
        const plaintext = await decryptAttachment(ciphertext, encryption);
        if (revoked) return;

        // The stored MIME type is the sender's claim about bytes this browser
        // is about to render. Images are constrained to image/* so a file
        // announced as a PNG can't come back as HTML and run in this origin.
        const declared = mimeType ?? "application/octet-stream";
        const safeType = declared.startsWith("image/")
          ? declared
          : "application/octet-stream";

        url = URL.createObjectURL(new Blob([plaintext], { type: safeType }));
        setObjectUrl(url);
      } catch (err) {
        if (revoked) return;
        setError(
          err instanceof AttachmentError
            ? err.message
            : err instanceof Error
              ? err.message
              : "Couldn't decrypt this file."
        );
      }
    })();

    return () => {
      revoked = true;
      // Blobs are held by the document until revoked; a channel with a hundred
      // images would otherwise keep every one of them in memory for the tab's
      // lifetime.
      if (url) URL.revokeObjectURL(url);
      setObjectUrl(null);
    };
  }, [cid, encryption, mimeType]);

  if (encryption === undefined) {
    return (
      <div className="mt-1 flex items-center gap-2 rounded-lg border border-slate-800 bg-slate-900 px-3 py-2 max-w-sm text-sm text-slate-500">
        <Lock className="w-3.5 h-3.5 shrink-0" />
        <span className="min-w-0">
          <span className="block truncate italic">{filename}</span>
          <span className="block text-[11px]">
            Waiting for the key to this file.
          </span>
        </span>
      </div>
    );
  }

  if (error) {
    return (
      <div className="mt-1 flex items-center gap-2 rounded-lg border border-amber-900 bg-amber-950/30 px-3 py-2 max-w-sm text-sm text-amber-400">
        <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
        <span className="min-w-0">
          <span className="block truncate">{filename}</span>
          <span className="block text-[11px]">{error}</span>
        </span>
      </div>
    );
  }

  // Unencrypted: the browser fetches it itself, exactly as before.
  const href = encryption === null ? `/api/files/${cid}` : objectUrl;

  if (!href) {
    return (
      <div className="mt-1 flex items-center gap-2 rounded-lg border border-slate-800 bg-slate-900 px-3 py-2 max-w-sm text-sm text-slate-500">
        <Loader2 className="w-3.5 h-3.5 shrink-0 animate-spin" />
        <span className="truncate">{filename}</span>
      </div>
    );
  }

  if (mimeType?.startsWith("image/")) {
    return (
      <a href={href} target="_blank" rel="noreferrer">
        <img
          src={href}
          alt={filename}
          className="mt-1 max-w-sm max-h-72 rounded-lg border border-slate-800 object-contain"
        />
      </a>
    );
  }

  return (
    <a
      href={href}
      download={filename}
      className="mt-1 flex items-center gap-3 rounded-lg bg-slate-900 border border-slate-800 px-3 py-2 max-w-sm hover:border-purple-700 transition-colors"
    >
      {encryption ? (
        <Lock className="w-4 h-4 text-emerald-400 shrink-0" />
      ) : (
        <Download className="w-4 h-4 text-purple-400 shrink-0" />
      )}
      <span className="min-w-0">
        <span className="block text-sm text-slate-200 truncate">
          {filename}
        </span>
        <span className="block text-[11px] text-slate-500">
          {formatBytes(fileSize)}
        </span>
      </span>
    </a>
  );
}
