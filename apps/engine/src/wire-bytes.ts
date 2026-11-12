// Bytes on the client door (spec 40 M3): JSON can't carry a Uint8Array, so the door's wire form for
// one is `{ "$bytes": "<base64>" }`. The door decodes it in a call's input (an attachment upload,
// `workItem.attachment.add`) and encodes every Uint8Array in an output (`workItem.attachment.get`).
// Operations still see and validate plain Uint8Arrays; nothing else about the call changes.
import { OperationError } from "@software-factory/core";

const isWire = (v: unknown): v is { $bytes: string } =>
  !!v &&
  typeof v === "object" &&
  !Array.isArray(v) &&
  Object.keys(v).length === 1 &&
  typeof (v as { $bytes?: unknown }).$bytes === "string";

function fromBase64(text: string): Uint8Array {
  let binary: string;
  try {
    binary = atob(text);
  } catch {
    throw new OperationError("invalid_input", "$bytes is not base64");
  }
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  // In chunks: String.fromCharCode takes its arguments on the stack.
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

/** A call's input with every `{ $bytes }` turned into a Uint8Array. */
export function decodeBytes(value: unknown): unknown {
  if (isWire(value)) return fromBase64(value.$bytes);
  if (Array.isArray(value)) return value.map(decodeBytes);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, decodeBytes(v)]));
  }
  return value;
}

/** An output with every Uint8Array turned into `{ $bytes }`. */
export function encodeBytes(value: unknown): unknown {
  if (value instanceof Uint8Array) return { $bytes: toBase64(value) };
  if (Array.isArray(value)) return value.map(encodeBytes);
  if (value && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, encodeBytes(v)]));
  }
  return value;
}
