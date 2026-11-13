import { createRequire } from "node:module";

const r = createRequire(import.meta.url);
r("zod");
