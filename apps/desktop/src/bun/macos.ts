// AppKit and ServiceManagement bits Electrobun 2.0.6 has no API for (ADR 0390): the dock badge and
// launch at login, through the Objective-C runtime over bun:ffi. AppKit is main-thread only and the
// Bun main process may not be on it, so the badge goes through performSelectorOnMainThread.
import { dlopen, FFIType, type Pointer } from "bun:ffi";
import { cstr } from "./cf.ts";

const OBJC = "/usr/lib/libobjc.A.dylib";
dlopen("/System/Library/Frameworks/AppKit.framework/AppKit", {
  NSApplicationLoad: { args: [], returns: FFIType.bool },
});
let serviceManagement = false;
try {
  dlopen("/System/Library/Frameworks/ServiceManagement.framework/ServiceManagement", {
    SMLoginItemSetEnabled: { args: [FFIType.ptr, FFIType.bool], returns: FFIType.bool },
  });
  serviceManagement = true;
} catch {
  serviceManagement = false;
}
const rt = dlopen(OBJC, {
  objc_getClass: { args: [FFIType.cstring], returns: FFIType.ptr },
  sel_registerName: { args: [FFIType.cstring], returns: FFIType.ptr },
}).symbols;
const send0 = dlopen(OBJC, {
  objc_msgSend: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.ptr },
}).symbols.objc_msgSend;
const sendInt = dlopen(OBJC, {
  objc_msgSend: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.i64 },
}).symbols.objc_msgSend;
const sendPtrBool = dlopen(OBJC, {
  objc_msgSend: { args: [FFIType.ptr, FFIType.ptr, FFIType.ptr], returns: FFIType.bool },
}).symbols.objc_msgSend;
const sendStr = dlopen(OBJC, {
  objc_msgSend: { args: [FFIType.ptr, FFIType.ptr, FFIType.cstring], returns: FFIType.ptr },
}).symbols.objc_msgSend;
const sendPerform = dlopen(OBJC, {
  objc_msgSend: {
    args: [FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.bool],
    returns: FFIType.void,
  },
}).symbols.objc_msgSend;

const sel = (s: string) => rt.sel_registerName(cstr(s)) as Pointer;
const cls = (s: string) => rt.objc_getClass(cstr(s)) as Pointer | null;

export function setDockBadge(count: number): void {
  const app = cls("NSApplication");
  if (!app) return;
  const shared = send0(app, sel("sharedApplication")) as Pointer;
  const tile = send0(shared, sel("dockTile")) as Pointer;
  const label =
    count > 0
      ? (sendStr(
          cls("NSString") as Pointer,
          sel("stringWithUTF8String:"),
          cstr(String(count)),
        ) as Pointer)
      : null;
  sendPerform(
    tile,
    sel("performSelectorOnMainThread:withObject:waitUntilDone:"),
    sel("setBadgeLabel:"),
    label,
    false,
  );
}

/** SMAppService.mainApp (macOS 13+): the app itself as a login item. */
function mainAppService(): Pointer | null {
  if (!serviceManagement) return null;
  const c = cls("SMAppService");
  return c ? (send0(c, sel("mainAppService")) as Pointer) : null;
}

/** SMAppServiceStatusEnabled is 1. */
export function loginItemEnabled(): boolean {
  const svc = mainAppService();
  return svc ? Number(sendInt(svc, sel("status"))) === 1 : false;
}

export function setLoginItem(enable: boolean): boolean {
  const svc = mainAppService();
  if (!svc) return false;
  sendPtrBool(svc, sel(enable ? "registerAndReturnError:" : "unregisterAndReturnError:"), null);
  return loginItemEnabled();
}
