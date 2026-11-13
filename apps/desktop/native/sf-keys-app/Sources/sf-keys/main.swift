// sf-keys: SF Keys.app's executable, the only process that can use the desktop's device key
// (spec 40 M4b, ADR 0391, 0394). A P-256 key in the Secure Enclave, made with .privateKeyUsage and
// .userPresence, so every signature asks the person (Touch ID, or the login password), with no
// reuse window. The key is in the data-protection keychain under the helper's access group, which
// only a process whose own signed entitlements name it can use; only this helper's do.
//
//   sf-keys create <tag>             make the key (replacing one with this tag), print its JWK
//   sf-keys public <tag>             print the JWK of the existing key
//   sf-keys sign <tag> <base64>      sign a presence message (ECDSA P-256 SHA-256, DER), print base64
//   sf-keys delete <tag>
//
// The tag must be on the compiled-in allowlist, and `sign` signs presence messages only, with the
// Touch ID prompt built from the message's own summary line (the engine's words, never the
// caller's). Exit codes: SFKeysCore.Exit. SIGTERM (the app, when the challenge expires or the
// person cancels) takes the Touch ID sheet down and exits as cancelled.
import Foundation
import LocalAuthentication
import SFKeysCore
import Security

func finish(_ code: Exit, _ message: String? = nil) -> Never {
  if let message { FileHandle.standardError.write(Data((message + "\n").utf8)) }
  exit(code.rawValue)
}

/// The access group from this process's own signed entitlements, so the Team ID isn't compiled
/// in. Unsigned (dev) builds have none, and every command fails: the app then keeps a declared
/// software key.
func accessGroup() -> String {
  guard let task = SecTaskCreateFromSelf(nil),
    let value = SecTaskCopyValueForEntitlement(task, "keychain-access-groups" as CFString, nil),
    let groups = value as? [String],
    let group = groups.first(where: { $0.hasSuffix(".com.software-factory.desktop.keys") })
  else { finish(.other, "no keychain access group in this helper's signature (an unsigned build)") }
  return group
}

func b64url(_ data: Data) -> String {
  data.base64EncodedString().replacingOccurrences(of: "+", with: "-")
    .replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
}

func jwk(_ key: SecKey) -> String {
  guard let pub = SecKeyCopyPublicKey(key),
    let raw = SecKeyCopyExternalRepresentation(pub, nil) as Data?, raw.count == 65
  else { finish(.other, "no public key") }
  let x = b64url(raw.subdata(in: 1..<33))
  let y = b64url(raw.subdata(in: 33..<65))
  return "{\"kty\":\"EC\",\"crv\":\"P-256\",\"x\":\"\(x)\",\"y\":\"\(y)\"}"
}

/// The base of every query: this tag, in the data-protection keychain, in the access group.
func baseQuery(_ tag: String, _ group: String) -> [String: Any] {
  [
    kSecClass as String: kSecClassKey,
    kSecAttrApplicationTag as String: Data(tag.utf8),
    kSecAttrKeyType as String: kSecAttrKeyTypeECSECPrimeRandom,
    kSecUseDataProtectionKeychain as String: true,
    kSecAttrAccessGroup as String: group,
  ]
}

func findKey(_ tag: String, _ group: String, context: LAContext? = nil) -> SecKey {
  var query = baseQuery(tag, group)
  query[kSecReturnRef as String] = true
  if let context { query[kSecUseAuthenticationContext as String] = context }
  var item: CFTypeRef?
  let status = SecItemCopyMatching(query as CFDictionary, &item)
  guard status == errSecSuccess, let item else {
    finish(exitFor(status: status), status == errSecItemNotFound ? "no key \(tag)" : "OSStatus \(status)")
  }
  return (item as! SecKey)
}

func deleteKey(_ tag: String, _ group: String) {
  let status = SecItemDelete(baseQuery(tag, group) as CFDictionary)
  guard status == errSecSuccess || status == errSecItemNotFound else {
    finish(exitFor(status: status), "delete: OSStatus \(status)")
  }
}

/// The exit code and stderr for a CFError from the Security framework or LocalAuthentication.
func finish(_ error: Unmanaged<CFError>?, _ what: String) -> Never {
  guard let error = error?.takeRetainedValue() else { finish(.other, "\(what) failed") }
  let ns = error as Error as NSError
  let code: Exit =
    ns.domain == LAError.errorDomain ? exitFor(laCode: ns.code) : exitFor(status: Int32(ns.code))
  finish(code, "\(what): \(ns.domain) \(ns.code) \(ns.localizedDescription)")
}

func create(_ tag: String, _ group: String) -> Never {
  deleteKey(tag, group)
  var error: Unmanaged<CFError>?
  guard
    let access = SecAccessControlCreateWithFlags(
      nil, kSecAttrAccessibleWhenUnlockedThisDeviceOnly, [.privateKeyUsage, .userPresence], &error)
  else { finish(error, "access control") }
  let attributes: [String: Any] = [
    kSecAttrKeyType as String: kSecAttrKeyTypeECSECPrimeRandom,
    kSecAttrKeySizeInBits as String: 256,
    kSecAttrTokenID as String: kSecAttrTokenIDSecureEnclave,
    kSecUseDataProtectionKeychain as String: true,
    kSecAttrAccessGroup as String: group,
    kSecPrivateKeyAttrs as String: [
      kSecAttrIsPermanent as String: true,
      kSecAttrApplicationTag as String: Data(tag.utf8),
      kSecAttrAccessControl as String: access,
      kSecAttrAccessGroup as String: group,
    ],
  ]
  // Making the key never prompts; only using it does.
  guard let key = SecKeyCreateRandomKey(attributes as CFDictionary, &error) else {
    finish(error, "create")
  }
  print(jwk(key))
  finish(.done)
}

func sign(_ tag: String, _ message: Data, _ group: String) -> Never {
  // The exact bytes that will be signed are the ones parsed, and the prompt is built from them.
  let parsed: PresenceMessage
  switch parsePresenceMessage(message) {
  case .success(let m): parsed = m
  case .failure(let why): finish(.refused, "refused: \(why)")
  }
  let context = LAContext()
  // No reuse window (ADR 0391): every signature asks.
  context.touchIDAuthenticationAllowableReuseDuration = 0
  context.localizedReason = promptReason(parsed.summary)

  // SIGTERM from the app (the challenge expired, or the person cancelled in the app) takes the
  // Touch ID sheet down and exits as cancelled.
  signal(SIGTERM, SIG_IGN)
  let term = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .main)
  term.setEventHandler {
    context.invalidate()
    finish(.cancelled, "cancelled (SIGTERM)")
  }
  term.resume()

  DispatchQueue.global(qos: .userInitiated).async {
    let key = findKey(tag, group, context: context)
    var error: Unmanaged<CFError>?
    guard
      let signature = SecKeyCreateSignature(
        key, .ecdsaSignatureMessageX962SHA256, message as CFData, &error) as Data?
    else { finish(error, "sign") }
    print(signature.base64EncodedString())
    finish(.done)
  }
  dispatchMain()
}

let command: Command
switch parseArguments(Array(CommandLine.arguments.dropFirst())) {
case .success(let c): command = c
case .failure(let why): finish(.usage, why.description)
}
let group = accessGroup()
switch command {
case .create(let tag): create(tag, group)
case .publicKey(let tag): print(jwk(findKey(tag, group))); finish(.done)
case .sign(let tag, let message): sign(tag, message, group)
case .delete(let tag): deleteKey(tag, group); finish(.done)
}
