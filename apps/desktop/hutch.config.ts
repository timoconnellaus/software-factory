// @hutch cli=0.29.0 cottontail=0.7.3
// Hutch is Electrobun 2.x's toolchain (ADR 0380): it fetches the Electrobun SDK into .hutch/devkit
// and builds the bundle. Dependencies come from pnpm, not Hutch's own resolver.
export default {
  electrobun: {
    version: "2.0.6",
  },
};
