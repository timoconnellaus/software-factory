// The main process, for route-level tests (route-harness.tsx): signed in, a current build, and no
// pushes. Operations don't come through here; the harness connects its own fixture door.
const none = () => () => undefined;
const session = {
  signedIn: true,
  login: "owner",
  deviceId: "dev_m5",
  keyStorage: "secure-enclave",
  signingIn: false,
  error: null,
};
export const bun = {
  session: async () => session,
  updateStatus: async () => ({ required: false }),
};
export const onSession = none;
export const onRunner = none;
export const onInbox = none;
export const onPlanningChanged = none;
export const onNavigate = none;
export const onUpdate = none;
export const onTerminal = none;
