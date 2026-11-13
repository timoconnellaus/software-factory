import { join } from "node:path";
import { readFileSync } from "fs";

console.log(readFileSync, join, import.meta.url);
