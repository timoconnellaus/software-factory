declare namespace Cloudflare {
  interface Env {
    TEST_MIGRATIONS: import("cloudflare:test").D1Migration[];
    BETTER_AUTH_SECRET: string;
    GH_APP_CLIENT_SECRET: string;
    ATTACHMENTS: R2Bucket;
  }
}
