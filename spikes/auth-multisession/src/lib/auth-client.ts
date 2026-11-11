import { passkeyClient } from "@better-auth/passkey/client";
import { multiSessionClient, organizationClient } from "better-auth/client/plugins";
import { createAuthClient } from "better-auth/react";

// The Better Auth client acts on the *active* session only. Cross-account reads and writes go
// through /api/factory/* instead, which name the account explicitly.
export const authClient = createAuthClient({
  basePath: "/api/auth",
  plugins: [organizationClient(), multiSessionClient(), passkeyClient()],
});
