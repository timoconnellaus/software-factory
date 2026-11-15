import { OperationError } from "./errors.ts";
import type { AnyOperation } from "./operation.ts";
import * as cli from "./operations/cli.ts";
import * as desktop from "./operations/desktop.ts";
import * as device from "./operations/device.ts";
import * as devices from "./operations/devices.ts";
import * as github from "./operations/github.ts";
import * as mobile from "./operations/mobile.ts";
import * as orgs from "./operations/orgs.ts";
import * as runners from "./operations/runners.ts";

export const OPERATIONS: readonly AnyOperation[] = [
  orgs.orgList,
  github.githubConnectStart,
  github.githubConnectInstallation,
  github.githubInstallation,
  cli.cliDeviceStart,
  cli.cliDevicePoll,
  cli.cliDeviceLookup,
  cli.cliApproveDevice,
  cli.cliDenyDevice,
  cli.cliTokenList,
  cli.cliTokenRevoke,
  desktop.desktopAuthStart,
  desktop.desktopAuthLookup,
  desktop.desktopApproveDevice,
  desktop.desktopDenyDevice,
  desktop.desktopAuthExchange,
  desktop.desktopDeviceList,
  desktop.desktopDeviceRevoke,
  desktop.presenceChallenge,
  desktop.presenceRedeem,
  device.deviceList,
  device.deviceRevoke,
  device.deviceUpdate,
  mobile.mobileNonce,
  mobile.mobileAuthStart,
  mobile.mobileAuthLookup,
  mobile.mobileApproveDevice,
  mobile.mobileDenyDevice,
  mobile.mobileAuthExchange,
  mobile.mobilePairOffer,
  mobile.mobilePairOfferStatus,
  mobile.mobileRenew,
  runners.runnerRegister,
  runners.runnerRotateKey,
  runners.runnerList,
  runners.runnerAccountUse,
  runners.runnerHeartbeat,
  runners.runnerClaim,
  devices.runnerDeviceStart,
  devices.runnerDevicePoll,
  devices.runnerDeviceLookup,
  devices.runnerApproveDevice,
  devices.runnerDenyDevice,
];

const byName = new Map<string, AnyOperation>();
for (const op of OPERATIONS) {
  if (byName.has(op.name))
    throw new OperationError("conflict", `operation ${op.name} is defined twice`);
  byName.set(op.name, op);
}

export function getOperation(name: string): AnyOperation | undefined {
  return byName.get(name);
}

/** Every operation with its description, risk, actors and permission (`sf ops`, help). */
export function describeOperations() {
  return OPERATIONS.map((op) => ({
    name: op.name,
    description: op.description,
    risk: op.risk,
    actors: [...op.actors],
    permission: op.permission,
    /** Decided only in the browser (ADR 0340). */
    browserOnly: op.browserOnly === true,
  }));
}
