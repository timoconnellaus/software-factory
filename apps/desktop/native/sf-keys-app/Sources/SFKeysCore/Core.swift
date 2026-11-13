// What the key helper accepts, refuses and says (spec 40 M4b, ADR 0394), without the keychain.
import Foundation

/// Distinct exit codes; the app maps each to its own message (device-key.ts).
public enum Exit: Int32 {
  case done = 0
  case other = 1  // anything else, with the OSStatus on stderr
  case usage = 2  // usage, or a tag not on the allowlist
  case noKey = 3
  case cancelled = 4  // by the person, by SIGTERM or by the system
  case refused = 5  // the message is not a presence message
  case authFailed = 6  // wrong password too often, biometry locked out
}

/// The only tags the helper touches: the device key and the release's test tag. Any other tag is
/// refused before the keychain is touched.
public let allowedTags: Set<String> = [
  "com.software-factory.desktop.device-key",
  "com.software-factory.desktop.m4b-test",
]

/// Why a command line or a message was refused, in words for stderr.
public struct Refusal: Error, Equatable, CustomStringConvertible {
  public let description: String
  public init(_ description: String) { self.description = description }
}

public enum Command: Equatable {
  case create(tag: String)
  case publicKey(tag: String)
  case sign(tag: String, message: Data)
  case delete(tag: String)
}

/// The command line, or the usage error (exit 2) it is.
public func parseArguments(_ args: [String]) -> Result<Command, Refusal> {
  guard args.count >= 2 else { return .failure(Refusal("usage: sf-keys create|public|sign|delete <tag> …")) }
  let tag = args[1]
  guard allowedTags.contains(tag) else { return .failure(Refusal("tag not allowed: \(tag)")) }
  switch (args[0], args.count) {
  case ("create", 2): return .success(.create(tag: tag))
  case ("public", 2): return .success(.publicKey(tag: tag))
  case ("delete", 2): return .success(.delete(tag: tag))
  case ("sign", 3):
    guard let message = Data(base64Encoded: args[2]) else {
      return .failure(Refusal("usage: sf-keys sign <tag> <base64 presence message>"))
    }
    return .success(.sign(tag: tag, message: message))
  default:
    return .failure(Refusal("usage: sf-keys create|public|sign|delete <tag> …"))
  }
}

/// A presence message (ADR 0391): `nonce \n op \n sha-256 hex \n summary`, exactly as the engine
/// writes it (`presenceMessage` in packages/core). The summary is the engine's description of the
/// decision (`describeDecision`); the prompt shows it.
public struct PresenceMessage: Equatable {
  public let nonce: String
  public let op: String
  public let digest: String
  public let summary: String
}

public let maxMessageBytes = 2048
public let maxSummaryCharacters = 300

/// Parses the exact bytes the helper would sign; anything that isn't a presence message is refused,
/// which is what keeps the key from being a general signer.
public func parsePresenceMessage(_ data: Data) -> Result<PresenceMessage, Refusal> {
  guard data.count <= maxMessageBytes else { return .failure(Refusal("message too long")) }
  guard let text = String(data: data, encoding: .utf8) else { return .failure(Refusal("not UTF-8")) }
  // Split on the "\n" scalar, as the engine joins: Swift's Characters would read "\r\n" as one.
  let lines = text.components(separatedBy: "\n")
  guard lines.count == 4 else { return .failure(Refusal("a presence message has 4 lines, not \(lines.count)")) }
  let (nonce, op, digest, summary) = (lines[0], lines[1], lines[2], lines[3])
  let nonceChars = CharacterSet(charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_")
  guard (20...200).contains(nonce.count), nonce.unicodeScalars.allSatisfy(nonceChars.contains) else {
    return .failure(Refusal("not a nonce"))
  }
  guard presenceOps.contains(op) else { return .failure(Refusal("not an operation a presence proof decides: \(op)")) }
  let hex = CharacterSet(charactersIn: "0123456789abcdef")
  guard digest.count == 64, digest.unicodeScalars.allSatisfy(hex.contains) else {
    return .failure(Refusal("not a SHA-256 hex digest"))
  }
  guard !summary.trimmingCharacters(in: .whitespaces).isEmpty else { return .failure(Refusal("empty summary")) }
  guard summary.count <= maxSummaryCharacters else { return .failure(Refusal("summary too long")) }
  guard !summary.unicodeScalars.contains(where: { CharacterSet.controlCharacters.contains($0) }) else {
    return .failure(Refusal("control characters in the summary"))
  }
  return .success(PresenceMessage(nonce: nonce, op: op, digest: digest, summary: summary))
}

/// The Touch ID sheet's reason, completing macOS's sentence "SF Keys is trying to …": the
/// summary with its first letter lowercased ("merge 3f2a91c "Fix the inbox count" into main of
/// acme/widgets"). Nothing else is added: the words are the engine's.
public func promptReason(_ summary: String) -> String {
  guard let first = summary.first else { return summary }
  return first.lowercased() + summary.dropFirst()
}

/// The exit code for an OSStatus from the keychain or a signature.
public func exitFor(status: Int32) -> Exit {
  switch status {
  case -25300: return .noKey  // errSecItemNotFound
  case -128: return .cancelled  // errSecUserCanceled
  case -25293: return .authFailed  // errSecAuthFailed
  default: return .other
  }
}

/// The exit code for a LocalAuthentication error code (LAError.Code raw values).
public func exitFor(laCode: Int) -> Exit {
  switch laCode {
  case -2, -4, -9: return .cancelled  // userCancel, systemCancel, appCancel
  case -1, -8: return .authFailed  // authenticationFailed, biometryLockout
  default: return .other
  }
}
