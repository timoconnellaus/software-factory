// The operations the front ends call (the website and the desktop app), typed from their zod schemas
// in packages/core (types only: nothing from core runs in a view), and the new core's `flow.*`
// (flow.ts). How a call travels is each app's business: the website's server functions, or the
// desktop's main process and the client door.
import type { operations } from "@software-factory/core";
import type { z } from "zod";
import type { FlowOpMap } from "./flow.ts";

type Def<T> = T extends { input: infer I extends z.ZodType; output: infer O extends z.ZodType }
  ? { input: z.input<I>; output: z.output<O> }
  : never;

/** The platform's operations (packages/core), and the new core's `flow.*` (flow.ts). */
export interface OpMap extends FlowOpMap {
  "org.list": Def<typeof operations.orgList>;
  "github.connectStart": Def<typeof operations.githubConnectStart>;
  "runner.deviceLookup": Def<typeof operations.runnerDeviceLookup>;
  "runner.approveDevice": Def<typeof operations.runnerApproveDevice>;
  "runner.denyDevice": Def<typeof operations.runnerDenyDevice>;
  "runner.register": Def<typeof operations.runnerRegister>;
  "runner.rotateKey": Def<typeof operations.runnerRotateKey>;
  "runner.list": Def<typeof operations.runnerList>;
  "runner.account.use": Def<typeof operations.runnerAccountUse>;
  "cli.deviceLookup": Def<typeof operations.cliDeviceLookup>;
  "cli.approveDevice": Def<typeof operations.cliApproveDevice>;
  "cli.denyDevice": Def<typeof operations.cliDenyDevice>;
  "cliToken.list": Def<typeof operations.cliTokenList>;
  "cliToken.revoke": Def<typeof operations.cliTokenRevoke>;
  "desktop.authLookup": Def<typeof operations.desktopAuthLookup>;
  "desktop.approveDevice": Def<typeof operations.desktopApproveDevice>;
  "desktop.denyDevice": Def<typeof operations.desktopDenyDevice>;
  "desktopDevice.list": Def<typeof operations.desktopDeviceList>;
  "desktopDevice.revoke": Def<typeof operations.desktopDeviceRevoke>;
  "device.list": Def<typeof operations.deviceList>;
  "device.revoke": Def<typeof operations.deviceRevoke>;
  "device.update": Def<typeof operations.deviceUpdate>;
  "mobile.authLookup": Def<typeof operations.mobileAuthLookup>;
  "mobile.approveDevice": Def<typeof operations.mobileApproveDevice>;
  "mobile.denyDevice": Def<typeof operations.mobileDenyDevice>;
  "mobile.pairOffer": Def<typeof operations.mobilePairOffer>;
  "mobile.pairOfferStatus": Def<typeof operations.mobilePairOfferStatus>;
}

export type OpName = keyof OpMap;
export type OpInput<N extends OpName> = OpMap[N]["input"];
export type OpOutput<N extends OpName> = OpMap[N]["output"];

/** JSON as it crosses a process or network boundary (operation outputs are plain JSON). */
export type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

/** A refusal surfaced to UI code as an error, with its stable code. */
export class OpError extends Error {
  constructor(
    readonly code: string,
    message: string,
    /** What the refusal carries beside its message (a refused workflow's problems). */
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "OpError";
  }
}
