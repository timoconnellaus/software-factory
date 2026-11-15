// The key helper's parser and allowlist (spec 40 M4b, "Tests the build must have").
import Foundation
import XCTest

@testable import SFKeysCore

final class PresenceMessageTests: XCTestCase {
  let nonce = "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_xy"
  let digest = String(repeating: "0123456789abcdef", count: 4)
  let summary = "Merge 3f2a91c into main of acme/widgets: \"Fix the inbox count\""

  func message(_ lines: [String]) -> Data { Data(lines.joined(separator: "\n").utf8) }
  func refused(_ lines: [String], _ why: String, file: StaticString = #filePath, line: UInt = #line) {
    switch parsePresenceMessage(message(lines)) {
    case .success: XCTFail("accepted: \(lines)", file: file, line: line)
    case .failure(let got): XCTAssertTrue(got.description.contains(why), "\(got) ∌ \(why)", file: file, line: line)
    }
  }

  func testWellFormed() throws {
    let m = try parsePresenceMessage(message([nonce, "mobile.pairOffer", digest, summary])).get()
    XCTAssertEqual(m, PresenceMessage(nonce: nonce, op: "mobile.pairOffer", digest: digest, summary: summary))
  }

  func testMissingLine() { refused([nonce, "mobile.pairOffer", digest], "4 lines") }
  func testExtraLines() { refused([nonce, "mobile.pairOffer", digest, summary, "more"], "4 lines") }
  func testTrailingNewline() { refused([nonce, "mobile.pairOffer", digest, summary, ""], "4 lines") }
  func testNonHexDigest() {
    refused([nonce, "mobile.pairOffer", String(repeating: "g", count: 64), summary], "digest")
    refused([nonce, "mobile.pairOffer", digest.uppercased(), summary], "digest")
    refused([nonce, "mobile.pairOffer", String(digest.dropLast()), summary], "digest")
  }
  func testUnknownOp() {
    refused([nonce, "workItem.create", digest, summary], "not an operation")
    refused([nonce, "", digest, summary], "not an operation")
  }
  func testEmptySummary() {
    refused([nonce, "mobile.pairOffer", digest, ""], "empty summary")
    refused([nonce, "mobile.pairOffer", digest, "   "], "empty summary")
  }
  func testOverlongSummary() {
    refused([nonce, "mobile.pairOffer", digest, String(repeating: "a", count: maxSummaryCharacters + 1)], "too long")
  }
  func testControlCharactersInSummary() { refused([nonce, "mobile.pairOffer", digest, "Merge\u{1b}[2J"], "control") }
  func testLineAndParagraphSeparatorsInSummary() {
    // CharacterSet.controlCharacters has neither; both render as a line break in the sheet.
    refused([nonce, "mobile.pairOffer", digest, "Merge 3f2a91c\u{2028}into main"], "separator")
    refused([nonce, "mobile.pairOffer", digest, "Merge 3f2a91c\u{2029}into main"], "separator")
  }
  func testFormatCharactersInSummary() {
    refused([nonce, "mobile.pairOffer", digest, "Merge\u{200B} 3f2a91c"], "format")
    refused([nonce, "mobile.pairOffer", digest, "Merge \u{202E}cb19a2f3"], "format")
  }
  func testOrdinaryUnicodeSummaryIsAccepted() throws {
    let m = try parsePresenceMessage(message([nonce, "device.update", digest, "Rename this Mac to \"Café – naïve 日本\""])).get()
    XCTAssertEqual(m.op, "device.update")
  }
  func testBadNonce() {
    refused(["short", "mobile.pairOffer", digest, summary], "nonce")
    refused([nonce + "/+", "mobile.pairOffer", digest, summary], "nonce")
  }
  func testNotUTF8() {
    XCTAssertThrowsError(try parsePresenceMessage(Data([0xff, 0xfe, 0x0a])).get())
  }
  func testOverlongMessage() {
    XCTAssertThrowsError(try parsePresenceMessage(Data(count: maxMessageBytes + 1)).get())
  }
  func testCRLFIsNotAPresenceMessage() {
    // A \r would end up in the op or digest: refused.
    refused([nonce + "\r", "mobile.pairOffer", digest, summary], "nonce")
  }
}

final class ArgumentsTests: XCTestCase {
  let device = "com.software-factory.desktop.device-key"
  let test = "com.software-factory.desktop.m4b-test"

  func testAllowedTags() {
    XCTAssertEqual(try parseArguments(["create", device]).get(), .create(tag: device))
    XCTAssertEqual(try parseArguments(["public", test]).get(), .publicKey(tag: test))
    XCTAssertEqual(try parseArguments(["delete", device]).get(), .delete(tag: device))
    XCTAssertEqual(
      try parseArguments(["sign", device, Data("hi".utf8).base64EncodedString()]).get(),
      .sign(tag: device, message: Data("hi".utf8)))
  }
  func testTagNotOnTheList() {
    for args in [["create", "com.other.key"], ["public", ""], ["sign", "x", "aGk="], ["delete", device + "2"]] {
      XCTAssertThrowsError(try parseArguments(args).get(), "\(args)")
    }
  }
  func testUsage() {
    for args in [[], ["create"], ["frobnicate", device], ["create", device, "extra"], ["sign", device], ["sign", device, "not base64!"]] {
      XCTAssertThrowsError(try parseArguments(args).get(), "\(args)")
    }
  }
}

final class PromptAndExitTests: XCTestCase {
  func testReasonCompletesTheSentence() {
    XCTAssertEqual(
      promptReason("Merge 3f2a91c into main of acme/widgets: \"Fix the inbox count\""),
      "merge 3f2a91c into main of acme/widgets: \"Fix the inbox count\"")
    XCTAssertEqual(promptReason("Approve the spec for #12"), "approve the spec for #12")
  }
  func testExitCodes() {
    XCTAssertEqual(Exit.done.rawValue, 0)
    XCTAssertEqual(Exit.usage.rawValue, 2)
    XCTAssertEqual(exitFor(status: -25300), .noKey)
    XCTAssertEqual(exitFor(status: -128), .cancelled)
    XCTAssertEqual(exitFor(status: -25293), .authFailed)
    XCTAssertEqual(exitFor(status: -34018), .other)
    XCTAssertEqual(exitFor(laCode: -2), .cancelled)
    XCTAssertEqual(exitFor(laCode: -4), .cancelled)
    XCTAssertEqual(exitFor(laCode: -1), .authFailed)
    XCTAssertEqual(exitFor(laCode: -8), .authFailed)
    XCTAssertEqual(Exit.refused.rawValue, 5)
  }
}
