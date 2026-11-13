// The signing spike's probe (spec 40 M4b, ADR 0394): it uses no key. It prints the entitlements
// its own signature carries and exits 0, so a launch proves macOS (AMFI) accepted the embedded
// provisioning profile for them: a helper whose restricted entitlements the profile doesn't
// authorise is killed before main (SIGKILL), and one with no signature prints nothing.
import Foundation
import Security

let keys = [
  "com.apple.application-identifier",
  "com.apple.developer.team-identifier",
  "keychain-access-groups",
]
guard let task = SecTaskCreateFromSelf(nil) else {
  FileHandle.standardError.write("sf-keys: no SecTask for self\n".data(using: .utf8)!)
  exit(1)
}
var out: [String: Any] = [:]
for key in keys {
  if let value = SecTaskCopyValueForEntitlement(task, key as CFString, nil) {
    out[key] = value
  }
}
let json = try JSONSerialization.data(withJSONObject: out, options: [.sortedKeys])
print(String(data: json, encoding: .utf8)!)
exit(0)
