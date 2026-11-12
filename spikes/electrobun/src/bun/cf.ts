// Just enough CoreFoundation over bun:ffi to build Keychain queries and Objective-C calls.
// Data symbols (kCFBooleanTrue, the dictionary callbacks) are found with dlsym, since bun:ffi only
// binds functions.
import { CString, dlopen, FFIType, ptr, read, toArrayBuffer, type Pointer } from "bun:ffi";

const CF = "/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation";
const UTF8 = 0x08000100;

export const cf = dlopen(CF, {
	CFStringCreateWithCString: { args: [FFIType.ptr, FFIType.cstring, FFIType.u32], returns: FFIType.ptr },
	CFDataCreate: { args: [FFIType.ptr, FFIType.ptr, FFIType.i64], returns: FFIType.ptr },
	CFDataGetLength: { args: [FFIType.ptr], returns: FFIType.i64 },
	CFDataGetBytePtr: { args: [FFIType.ptr], returns: FFIType.ptr },
	CFDictionaryCreateMutable: { args: [FFIType.ptr, FFIType.i64, FFIType.ptr, FFIType.ptr], returns: FFIType.ptr },
	CFDictionarySetValue: { args: [FFIType.ptr, FFIType.ptr, FFIType.ptr], returns: FFIType.void },
	CFRelease: { args: [FFIType.ptr], returns: FFIType.void },
}).symbols;

const libSystem = dlopen("/usr/lib/libSystem.B.dylib", {
	dlsym: { args: [FFIType.i64, FFIType.cstring], returns: FFIType.ptr },
}).symbols;
const RTLD_DEFAULT = -2;

export const cstr = (s: string) => Buffer.from(`${s}\0`, "utf8");

/** The address of a data symbol (e.g. a `const CFStringRef`), not its value. */
export function dataSymbol(name: string): Pointer {
	const p = libSystem.dlsym(RTLD_DEFAULT, cstr(name));
	if (!p) throw new Error(`no symbol ${name}`);
	return p as Pointer;
}

/** The value of a `const X *` data symbol. */
export const symbolValue = (name: string) => read.ptr(dataSymbol(name)) as unknown as Pointer;

export const cfString = (s: string) => cf.CFStringCreateWithCString(null, cstr(s), UTF8) as Pointer;

export function cfData(bytes: Uint8Array) {
	return cf.CFDataCreate(null, ptr(bytes), bytes.byteLength) as Pointer;
}

export function cfDataBytes(data: Pointer): Uint8Array {
	const len = Number(cf.CFDataGetLength(data));
	const p = cf.CFDataGetBytePtr(data) as Pointer;
	return new Uint8Array(toArrayBuffer(p, 0, len)).slice();
}

export function cfDict(entries: Array<[Pointer, Pointer]>): Pointer {
	const d = cf.CFDictionaryCreateMutable(
		null,
		0,
		dataSymbol("kCFTypeDictionaryKeyCallBacks"),
		dataSymbol("kCFTypeDictionaryValueCallBacks"),
	) as Pointer;
	for (const [k, v] of entries) cf.CFDictionarySetValue(d, k, v);
	return d;
}

export { CString };
