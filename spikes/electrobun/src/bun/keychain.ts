// The desktop token in the macOS Keychain, through Security.framework (no `security` CLI: an item
// the CLI writes trusts the CLI, not the app). The question the spike answers: which process does
// the item's access control trust, and can a shell or a Claude sandbox read it?
//
// Two modes:
// - "file": the login keychain. The item's ACL trusts the creating executable's code signature;
//   anything else reading the secret gets a system prompt.
// - "dataProtection": the iOS-style keychain (kSecUseDataProtectionKeychain). Only processes signed
//   with an entitlement for the item's access group can see it at all; no prompt, just
//   errSecItemNotFound. Needs a real Team ID signature (keychain-access-groups).
import { dlopen, FFIType, ptr, type Pointer } from "bun:ffi";
import { cf, cfData, cfDataBytes, cfDict, cfString, dataSymbol, symbolValue } from "./cf.ts";

const sec = dlopen("/System/Library/Frameworks/Security.framework/Security", {
	SecItemAdd: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
	SecItemDelete: { args: [FFIType.ptr], returns: FFIType.i32 },
	SecItemCopyMatching: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
}).symbols;

// Load Security before looking its data symbols up.
const k = (name: string) => symbolValue(name);
const TRUE = () => symbolValue("kCFBooleanTrue");
void dataSymbol;

export type Mode = "file" | "dataProtection";
export const SERVICE = "dev.software-factory.spike.desktop-token";
const ACCOUNT = "default";

function base(mode: Mode): Array<[Pointer, Pointer]> {
	const e: Array<[Pointer, Pointer]> = [
		[k("kSecClass"), k("kSecClassGenericPassword")],
		[k("kSecAttrService"), cfString(SERVICE)],
		[k("kSecAttrAccount"), cfString(ACCOUNT)],
	];
	if (mode === "dataProtection") e.push([k("kSecUseDataProtectionKeychain"), TRUE()]);
	return e;
}

export function saveToken(token: string, mode: Mode = "file"): number {
	sec.SecItemDelete(cfDict(base(mode)));
	const attrs = cfDict([...base(mode), [k("kSecValueData"), cfData(new TextEncoder().encode(token))]]);
	const status = sec.SecItemAdd(attrs, null);
	cf.CFRelease(attrs);
	return status;
}

export function readToken(mode: Mode = "file"): { status: number; token: string | null } {
	const q = cfDict([
		...base(mode),
		[k("kSecReturnData"), TRUE()],
		[k("kSecMatchLimit"), k("kSecMatchLimitOne")],
	]);
	const out = new BigUint64Array(1);
	const status = sec.SecItemCopyMatching(q, ptr(out));
	cf.CFRelease(q);
	if (status !== 0) return { status, token: null };
	const data = Number(out[0]) as unknown as Pointer;
	const token = new TextDecoder().decode(cfDataBytes(data));
	cf.CFRelease(data);
	return { status, token };
}

export function deleteToken(mode: Mode = "file"): number {
	return sec.SecItemDelete(cfDict(base(mode)));
}
