// swift-tools-version:5.9
// SF Runner.app's main executable, the launcher (spec 45 §1, ADR 0643). LauncherCore holds what can
// be tested without a signed bundle (the entry table and its argument grammar, Node's environment,
// the sealed hash of a script); `sf-runner` is the code-signing checks and the spawn around it.
//   swift test --package-path apps/desktop/native/sf-runner-launcher
//   node apps/desktop/scripts/runner-app.mjs   (builds SF Runner.app around it)
import PackageDescription

let package = Package(
  name: "sf-runner-launcher",
  platforms: [.macOS(.v14)],
  targets: [
    .target(name: "LauncherCore"),
    .executableTarget(name: "sf-runner", dependencies: ["LauncherCore"]),
    .testTarget(name: "LauncherCoreTests", dependencies: ["LauncherCore"]),
  ]
)
