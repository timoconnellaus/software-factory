// swift-tools-version:5.9
// The key helper, SF Keys.app's executable (spec 40 M4b, ADR 0394). SFKeysCore holds what can be
// tested without a Secure Enclave (the presence-message parser, the tag allowlist, the exit codes,
// the prompt's words); `sf-keys` is the keychain and LocalAuthentication around it.
//   swift test --package-path apps/desktop/native/sf-keys-app
//   swift build -c release --package-path apps/desktop/native/sf-keys-app   (scripts/bundle.sh)
import PackageDescription

let package = Package(
  name: "sf-keys",
  platforms: [.macOS(.v14)],
  targets: [
    .target(name: "SFKeysCore"),
    .executableTarget(name: "sf-keys", dependencies: ["SFKeysCore"]),
    .testTarget(name: "SFKeysCoreTests", dependencies: ["SFKeysCore"]),
  ]
)
