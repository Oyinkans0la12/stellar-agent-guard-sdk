/**
 * Browser-safe SHA-256 helpers.
 *
 * The root entry must not import Node built-ins (design principle 5), so the
 * hashing used by pre-flight cache fingerprints, auth-entry signing and
 * telemetry ids goes through the Stellar SDK's own SHA-256 implementation. That
 * implementation is synchronously usable and browser-compatible, which keeps
 * this module free of `node:crypto` and of an async WebCrypto boundary.
 */
import { hash as sha256Digest } from "@stellar/stellar-sdk";

const encoder = new TextEncoder();

/** UTF-8 bytes for a string, without relying on Node's `Buffer`. */
export function utf8Bytes(value: string): Uint8Array {
  return encoder.encode(value);
}

/** UTF-8 byte length of a string, without relying on Node's `Buffer`. */
export function utf8Length(value: string): number {
  return encoder.encode(value).length;
}

/** Lower-case hex rendering of a byte array. */
export function bytesToHex(bytes: Uint8Array): string {
  let hex = "";
  for (const byte of bytes) hex += byte.toString(16).padStart(2, "0");
  return hex;
}

/** Parse a hex string into bytes; throws on malformed input. */
export function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(hex)) {
    throw new Error("invalid hex string");
  }
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i += 1) {
    out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

/** SHA-256 digest of a string (UTF-8) or byte array. */
export function sha256(data: string | Uint8Array): Uint8Array {
  return sha256Digest(typeof data === "string" ? encoder.encode(data) : data);
}

/** SHA-256 of a string (UTF-8) or byte array, lower-case hex. */
export function sha256Hex(data: string | Uint8Array): string {
  return bytesToHex(sha256(data));
}

/** Concatenate byte arrays into one contiguous array. */
export function concatBytes(parts: readonly Uint8Array[]): Uint8Array {
  let length = 0;
  for (const part of parts) length += part.length;
  const out = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}
