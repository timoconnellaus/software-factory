// The worker `checkDesignBounded` runs a check in, so a design that takes too long can be stopped.
import { parentPort, workerData } from "node:worker_threads";
import { checkDesign } from "./index.ts";

const input = workerData as {
  type: Parameters<typeof checkDesign>[0];
  source: string;
  name: string;
};
parentPort?.postMessage(await checkDesign(input.type, input.source, input.name));
