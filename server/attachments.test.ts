import { describe, expect, it } from "vitest";
import {
  ATTACHMENT_EVENT_KEY,
  AttachmentError,
  decryptAttachment,
  encryptAttachment,
  readAttachment,
  type EncryptedAttachment,
} from "@shared/attachments";

/**
 * Encrypted attachments, exercised with real WebCrypto.
 *
 * Node 22 provides the same `crypto.subtle` the browser does, so these are not
 * testing a mock of the cryptography — they run it. What's worth asserting is
 * the surrounding format: the IV shape that prevents keystream reuse, the hash
 * check that AES-CTR cannot do for itself, and the refusals.
 */

const text = new TextEncoder();
const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

describe("round trip", () => {
  it("returns exactly what went in", async () => {
    const plaintext = text.encode("the quick brown fox\n".repeat(500));
    const { ciphertext, info } = await encryptAttachment(plaintext);
    expect(decode(await decryptAttachment(ciphertext, info))).toBe(
      decode(plaintext)
    );
  });

  it("actually encrypts — the ciphertext isn't the plaintext", async () => {
    // The failure this catches is a stub that returns its input, which every
    // other test in this file would pass happily.
    const plaintext = text.encode("secret".repeat(100));
    const { ciphertext } = await encryptAttachment(plaintext);
    expect(Buffer.from(ciphertext).equals(Buffer.from(plaintext))).toBe(false);
  });

  it("handles an empty file and a single byte", async () => {
    for (const input of [new Uint8Array(0), new Uint8Array([0x42])]) {
      const { ciphertext, info } = await encryptAttachment(input);
      const out = await decryptAttachment(ciphertext, info);
      expect(Array.from(out)).toEqual(Array.from(input));
    }
  });

  it("handles bytes that aren't text", async () => {
    const binary = new Uint8Array(4096);
    for (let i = 0; i < binary.length; i++) binary[i] = (i * 7) % 256;
    const { ciphertext, info } = await encryptAttachment(binary);
    expect(Array.from(await decryptAttachment(ciphertext, info))).toEqual(
      Array.from(binary)
    );
  });
});

describe("the key and IV are shaped the way AES-CTR needs", () => {
  it("uses a fresh key and IV every time", async () => {
    // Same plaintext twice must not produce the same ciphertext. If it did,
    // an operator could tell that two people shared the same file.
    const plaintext = text.encode("identical contents");
    const a = await encryptAttachment(plaintext);
    const b = await encryptAttachment(plaintext);
    expect(a.info.key.k).not.toBe(b.info.key.k);
    expect(a.info.iv).not.toBe(b.info.iv);
    expect(Buffer.from(a.ciphertext).equals(Buffer.from(b.ciphertext))).toBe(
      false
    );
  });

  it("zeroes the top half of the IV", async () => {
    // The spec reserves the low 64 bits for the counter. A fully random IV
    // works almost always and then catastrophically reuses keystream across
    // two files when a counter carries into the nonce — silently, with no
    // error anywhere.
    for (let attempt = 0; attempt < 20; attempt++) {
      const { info } = await encryptAttachment(text.encode("x"));
      const iv = Buffer.from(info.iv, "base64");
      expect(iv).toHaveLength(16);
      expect(Array.from(iv.subarray(0, 8))).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
    }
  });

  it("emits a 256-bit key in the JWK shape the spec names", async () => {
    const { info } = await encryptAttachment(text.encode("x"));
    expect(info.key.kty).toBe("oct");
    expect(info.key.alg).toBe("A256CTR");
    expect(info.key.ext).toBe(true);
    expect(info.key.key_ops).toContain("decrypt");
    // URL-safe base64, unpadded, decoding to 32 bytes.
    expect(info.key.k).not.toMatch(/[+/=]/);
    expect(Buffer.from(info.key.k, "base64url")).toHaveLength(32);
  });

  it("hashes the ciphertext, not the plaintext", async () => {
    const plaintext = text.encode("hash me");
    const { ciphertext, info } = await encryptAttachment(plaintext);
    const { createHash } = await import("node:crypto");
    const expected = createHash("sha256")
      .update(Buffer.from(ciphertext))
      .digest("base64")
      .replace(/=+$/, "");
    expect(info.hashes.sha256).toBe(expected);
  });
});

describe("tampering is refused, not decrypted", () => {
  it("rejects a flipped bit rather than returning altered bytes", async () => {
    // The whole reason the hash exists. AES-CTR is unauthenticated: flipping a
    // ciphertext bit flips the same plaintext bit and nothing complains. An
    // instance could hand back modified bytes and a client without this check
    // would render them under a lock icon.
    const { ciphertext, info } = await encryptAttachment(
      text.encode("original contents")
    );
    ciphertext[3] ^= 0x01;
    await expect(decryptAttachment(ciphertext, info)).rejects.toThrow(
      AttachmentError
    );
  });

  it("says the file was altered, in words", async () => {
    const { ciphertext, info } = await encryptAttachment(
      text.encode("original")
    );
    ciphertext[0] ^= 0xff;
    await expect(decryptAttachment(ciphertext, info)).rejects.toThrow(
      /altered or corrupted/i
    );
  });

  it("rejects truncation", async () => {
    const { ciphertext, info } = await encryptAttachment(
      text.encode("a".repeat(200))
    );
    await expect(
      decryptAttachment(ciphertext.slice(0, 100), info)
    ).rejects.toThrow(AttachmentError);
  });

  it("rejects a substituted file, even one that decrypts", async () => {
    const a = await encryptAttachment(text.encode("the real file"));
    const b = await encryptAttachment(text.encode("the swapped file"));
    // b's ciphertext under a's key would produce garbage rather than an error
    // without the hash check — garbage the UI would then display.
    await expect(decryptAttachment(b.ciphertext, a.info)).rejects.toThrow(
      AttachmentError
    );
  });
});

describe("malformed metadata is refused", () => {
  const valid = async () => (await encryptAttachment(text.encode("x"))).info;

  it("refuses an unknown version", async () => {
    const info = {
      ...(await valid()),
      v: "v1",
    } as unknown as EncryptedAttachment;
    await expect(decryptAttachment(new Uint8Array(1), info)).rejects.toThrow(
      /Unsupported attachment version/
    );
  });

  it("refuses an algorithm it doesn't implement", async () => {
    const base = await valid();
    const info = {
      ...base,
      key: { ...base.key, alg: "A128CTR" },
    } as unknown as EncryptedAttachment;
    await expect(decryptAttachment(new Uint8Array(1), info)).rejects.toThrow(
      /algorithm/i
    );
  });

  it("refuses a key of the wrong length", async () => {
    const { ciphertext, info } = await encryptAttachment(text.encode("x"));
    const short = { ...info, key: { ...info.key, k: info.key.k.slice(0, 20) } };
    await expect(decryptAttachment(ciphertext, short)).rejects.toThrow(
      /key is the wrong length/
    );
  });

  it("refuses an IV of the wrong length", async () => {
    const { ciphertext, info } = await encryptAttachment(text.encode("x"));
    const short = { ...info, iv: Buffer.alloc(8).toString("base64") };
    await expect(decryptAttachment(ciphertext, short)).rejects.toThrow(
      /IV is the wrong length/
    );
  });
});

describe("reading attachment metadata off an event", () => {
  it("finds a cid and its encryption info", async () => {
    const { info } = await encryptAttachment(text.encode("x"));
    const content = {
      msgtype: "m.file",
      body: "notes.pdf",
      [ATTACHMENT_EVENT_KEY]: { cid: "bafk123", size: 10, encryption: info },
    };
    const read = readAttachment(content);
    expect(read?.cid).toBe("bafk123");
    expect(read?.encryption?.v).toBe("v2");
  });

  it("reports a plaintext-channel share as having no encryption", () => {
    const read = readAttachment({
      [ATTACHMENT_EVENT_KEY]: { cid: "bafk123", size: 10 },
    });
    // Distinct from "not a file event" — the caller has to be able to tell a
    // file it should fetch as-is from one it has no key for.
    expect(read?.cid).toBe("bafk123");
    expect(read?.encryption).toBeNull();
  });

  it.each([
    [null, "null content"],
    [{}, "an ordinary message"],
    [{ [ATTACHMENT_EVENT_KEY]: {} }, "the key present but empty"],
    [{ [ATTACHMENT_EVENT_KEY]: { cid: "" } }, "an empty cid"],
    [
      { [ATTACHMENT_EVENT_KEY]: "bafk123" },
      "a string where the object should be",
    ],
  ])("returns null for %j — %s", (content, _why) => {
    expect(readAttachment(content)).toBeNull();
  });
});
