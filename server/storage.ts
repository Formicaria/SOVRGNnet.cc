// File storage helpers for SOVRGNnet
// Currently disabled - implement your own S3 or storage solution

export async function storagePut(
  relKey: string,
  data: Buffer | Uint8Array | string,
  contentType = "application/octet-stream"
): Promise<{ key: string; url: string }> {
  throw new Error("Storage not configured. Implement your own S3 or storage solution.");
}

export async function storageGet(relKey: string): Promise<{ key: string; url: string; }> {
  throw new Error("Storage not configured. Implement your own S3 or storage solution.");
}
