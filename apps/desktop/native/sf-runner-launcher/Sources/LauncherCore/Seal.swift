// A script's hash as the bundle's seal records it (spec 45 §1, step 5). The launcher reads the
// script into memory, hashes those bytes and compares with the seal it has just validated, then
// hands Node exactly those bytes through a pipe: what Node runs is what was checked.
import CryptoKit
import Foundation

public let bundleIdentifier = "com.software-factory.runner"
public let nodeIdentifier = "com.software-factory.runner.node"

/// The standard Developer ID requirement for `identifier` signed by `team` (spec 45 §1, step 2):
/// Apple's anchor, the Developer ID intermediate's and leaf's markers, the Team ID.
public func developerIdRequirement(identifier: String, team: String) -> String {
  "anchor apple generic and identifier \"\(identifier)\" and certificate 1[field.1.2.840.113635.100.6.2.6]"
    + " and certificate leaf[field.1.2.840.113635.100.6.1.13] and certificate leaf[subject.OU] = \"\(team)\""
}

/// Whether a compiled-in Team ID is one (ten upper-case letters and digits), or empty (a dev build).
public func isTeamId(_ team: String) -> Bool {
  team.count == 10 && team.allSatisfy { ($0.isASCII && $0.isUppercase) || ($0.isASCII && $0.isNumber) }
}

/// The SHA-256 the seal records for `relative` (a path under Contents, such as
/// `Resources/runner/sf-runner.cjs`), from the resource directory's `files2`, or nil. The launcher
/// takes the directory from the SecStaticCode it has just validated (signing information's
/// `ResourceDirectory`, which that object loaded once and checked), never by reading
/// `_CodeSignature/CodeResources` again: a pair swapped after the check would match itself.
public func sealedHash(resourceDirectory: [String: Any], relative: String) -> Data? {
  guard let files = resourceDirectory["files2"] as? [String: Any],
    let entry = files[relative] as? [String: Any],
    let hash = entry["hash2"] as? Data
  else { return nil }
  return hash
}

public func sha256(_ data: Data) -> Data { Data(SHA256.hash(data: data)) }

/// Why `bytes` aren't the sealed `relative`, or nil when they are.
public func checkScript(_ bytes: Data, relative: String, resourceDirectory: [String: Any]) -> String? {
  guard let want = sealedHash(resourceDirectory: resourceDirectory, relative: relative) else {
    return "\(relative) isn't in the bundle's seal"
  }
  return sha256(bytes) == want ? nil : "\(relative) doesn't match the bundle's seal"
}
