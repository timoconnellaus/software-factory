// Secrets in the login keychain, through Security.framework over bun:ffi (ADR 0381): the desktop
// token, and a software device key on builds without the Secure Enclave. The spike showed the
// keychain can't keep these from other processes of the same user (they trust the app's `bun`), so
// nothing here is proof of a person: gate decisions need the presence proof.
import { dlopen, FFIType, type Pointer, ptr } from "bun:ffi";
import { cf, cfData, cfDataBytes, cfDict, cfString, symbolValue } from "./cf.ts";

const sec = dlopen("/System/Library/Frameworks/Security.framework/Security", {
  SecItemAdd: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
  SecItemDelete: { args: [FFIType.ptr], returns: FFIType.i32 },
  SecItemCopyMatching: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
}).symbols;

const k = (name: string) => symbolValue(name);
const ACCOUNT = "default";
export const ERR_NOT_FOUND = -25300;

function base(service: string): Array<[Pointer, Pointer]> {
  return [
    [k("kSecClass"), k("kSecClassGenericPassword")],
    [k("kSecAttrService"), cfString(service)],
    [k("kSecAttrAccount"), cfString(ACCOUNT)],
  ];
}

export function setSecret(service: string, value: string): void {
  sec.SecItemDelete(cfDict(base(service)));
  const attrs = cfDict([
    ...base(service),
    [k("kSecValueData"), cfData(new TextEncoder().encode(value))],
  ]);
  const status = sec.SecItemAdd(attrs, null);
  cf.CFRelease(attrs);
  if (status !== 0) throw new Error(`keychain write failed (${status})`);
}

export function getSecret(service: string): string | null {
  const q = cfDict([
    ...base(service),
    [k("kSecReturnData"), symbolValue("kCFBooleanTrue")],
    [k("kSecMatchLimit"), k("kSecMatchLimitOne")],
  ]);
  const out = new BigUint64Array(1);
  const status = sec.SecItemCopyMatching(q, ptr(out));
  cf.CFRelease(q);
  if (status === ERR_NOT_FOUND) return null;
  if (status !== 0) throw new Error(`keychain read failed (${status})`);
  const data = Number(out[0]) as unknown as Pointer;
  const value = new TextDecoder().decode(cfDataBytes(data));
  cf.CFRelease(data);
  return value;
}

export function deleteSecret(service: string): void {
  sec.SecItemDelete(cfDict(base(service)));
}
