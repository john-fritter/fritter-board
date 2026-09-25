import { createHash, randomBytes } from "crypto";

/** A random, URL-safe secret. Session cookies and invite codes both use these. */
export function randomToken(bytes: number): string {
  return randomBytes(bytes).toString("base64url");
}

/** Sessions are stored by hash, so a leaked table can't be replayed as cookies. */
export function sha256(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}
