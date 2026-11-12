// Dock badge. Electrobun 2.0.6 has no API for it, so: [[NSApp dockTile] setBadgeLabel:] through
// the Objective-C runtime, sent with performSelectorOnMainThread (AppKit is main-thread only and
// the Bun main process may not be on it).
import { dlopen, FFIType, type Pointer } from "bun:ffi";
import { cstr } from "./cf.ts";

const OBJC = "/usr/lib/libobjc.A.dylib";
// Load AppKit so NSApplication resolves (bun:ffi needs at least one symbol).
dlopen("/System/Library/Frameworks/AppKit.framework/AppKit", { NSApplicationLoad: { args: [], returns: FFIType.bool } });
const rt = dlopen(OBJC, {
	objc_getClass: { args: [FFIType.cstring], returns: FFIType.ptr },
	sel_registerName: { args: [FFIType.cstring], returns: FFIType.ptr },
}).symbols;
// objc_msgSend bound once per signature.
const send0 = dlopen(OBJC, { objc_msgSend: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.ptr } }).symbols.objc_msgSend;
const sendStr = dlopen(OBJC, {
	objc_msgSend: { args: [FFIType.ptr, FFIType.ptr, FFIType.cstring], returns: FFIType.ptr },
}).symbols.objc_msgSend;
const sendPerform = dlopen(OBJC, {
	objc_msgSend: { args: [FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.bool], returns: FFIType.void },
}).symbols.objc_msgSend;

const sel = (s: string) => rt.sel_registerName(cstr(s)) as Pointer;
const cls = (s: string) => rt.objc_getClass(cstr(s)) as Pointer;

export function setDockBadge(count: number): void {
	const app = send0(cls("NSApplication"), sel("sharedApplication")) as Pointer;
	const tile = send0(app, sel("dockTile")) as Pointer;
	const label = count > 0 ? (sendStr(cls("NSString"), sel("stringWithUTF8String:"), cstr(String(count))) as Pointer) : null;
	sendPerform(tile, sel("performSelectorOnMainThread:withObject:waitUntilDone:"), sel("setBadgeLabel:"), label, false);
}
