// sf-keys: the desktop app's device key in the Secure Enclave (ADR 0381). A P-256 key made with
// .privateKeyUsage and .userPresence, so every signature asks the person for Touch ID (or their
// password); the private key never leaves the chip.
//
//   sf-keys create <tag>                  make the key (replacing one with this tag), print its JWK
//   sf-keys public <tag>                  print the JWK of the existing key
//   sf-keys sign <tag> <base64>           sign a presence message (ECDSA P-256 SHA-256, DER), print base64
//   sf-keys delete <tag>
//
// Only this helper is signed with the keychain access group, so the app's `bun` (which any process
// of the user can run with its own script) can't use the key at all. And it signs only a presence
// message (nonce, op, input digest, summary), with the Touch ID prompt built from the message's
// own summary line, which the engine wrote: no caller chooses what the prompt says (ADR 0381).
// Unsigned builds fail at `create` and the app falls back to a software key it declares as such.
import Foundation
import LocalAuthentication
import Security

func fail(_ message: String) -> Never {
  FileHandle.standardError.write((message + "\n").data(using: .utf8)!)
  exit(1)
}

func b64url(_ data: Data) -> String {
  data.base64EncodedString().replacingOccurrences(of: "+", with: "-")
    .replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
}

func findKey(_ tag: String, context: LAContext? = nil) -> SecKey? {
  var query: [String: Any] = [
    kSecClass as String: kSecClassKey,
    kSecAttrApplicationTag as String: tag.data(using: .utf8)!,
    kSecAttrKeyType as String: kSecAttrKeyTypeECSECPrimeRandom,
    kSecReturnRef as String: true,
  ]
  if let context { query[kSecUseAuthenticationContext as String] = context }
  var item: CFTypeRef?
  guard SecItemCopyMatching(query as CFDictionary, &item) == errSecSuccess else { return nil }
  return (item as! SecKey)
}

func jwk(_ key: SecKey) -> String {
  guard let pub = SecKeyCopyPublicKey(key),
    let raw = SecKeyCopyExternalRepresentation(pub, nil) as Data?, raw.count == 65
  else { fail("no public key") }
  let x = b64url(raw.subdata(in: 1..<33))
  let y = b64url(raw.subdata(in: 33..<65))
  return "{\"kty\":\"EC\",\"crv\":\"P-256\",\"x\":\"\(x)\",\"y\":\"\(y)\"}"
}

func delete(_ tag: String) {
  let query: [String: Any] = [
    kSecClass as String: kSecClassKey,
    kSecAttrApplicationTag as String: tag.data(using: .utf8)!,
  ]
  SecItemDelete(query as CFDictionary)
}

let args = CommandLine.arguments
guard args.count >= 3 else { fail("usage: sf-keys create|public|sign|delete <tag> …") }
let tag = args[2]

switch args[1] {
case "create":
  delete(tag)
  var error: Unmanaged<CFError>?
  guard
    let access = SecAccessControlCreateWithFlags(
      nil, kSecAttrAccessibleWhenUnlockedThisDeviceOnly, [.privateKeyUsage, .userPresence], &error)
  else { fail("access control: \(error!.takeRetainedValue())") }
  let attributes: [String: Any] = [
    kSecAttrKeyType as String: kSecAttrKeyTypeECSECPrimeRandom,
    kSecAttrKeySizeInBits as String: 256,
    kSecAttrTokenID as String: kSecAttrTokenIDSecureEnclave,
    kSecPrivateKeyAttrs as String: [
      kSecAttrIsPermanent as String: true,
      kSecAttrApplicationTag as String: tag.data(using: .utf8)!,
      kSecAttrAccessControl as String: access,
    ],
  ]
  guard let key = SecKeyCreateRandomKey(attributes as CFDictionary, &error) else {
    fail("create: \(error!.takeRetainedValue())")
  }
  print(jwk(key))
case "public":
  guard let key = findKey(tag) else { fail("no key \(tag)") }
  print(jwk(key))
case "sign":
  guard args.count >= 4, let message = Data(base64Encoded: args[3]),
    let text = String(data: message, encoding: .utf8)
  else { fail("usage: sf-keys sign <tag> <base64 presence message>") }
  // nonce \n op \n sha-256 hex \n summary: anything else is refused.
  let lines = text.components(separatedBy: "\n")
  guard lines.count == 4, lines[0].count >= 20, !lines[1].isEmpty,
    lines[2].count == 64, lines[2].allSatisfy({ $0.isHexDigit }), !lines[3].isEmpty
  else { fail("not a presence message") }
  let context = LAContext()
  context.localizedReason = "Software Factory: \(lines[3])"
  guard let key = findKey(tag, context: context) else { fail("no key \(tag)") }
  var error: Unmanaged<CFError>?
  guard
    let sig = SecKeyCreateSignature(
      key, .ecdsaSignatureMessageX962SHA256, message as CFData, &error) as Data?
  else { fail("sign: \(error!.takeRetainedValue())") }
  print(sig.base64EncodedString())
case "delete":
  delete(tag)
default:
  fail("unknown command \(args[1])")
}
