import Foundation
import XCTest

@testable import LauncherCore

let packageDir = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
  .deletingLastPathComponent()
/// local/runner-host, which owns the entry table and the cases both sides run.
let hostDir = packageDir.appendingPathComponent("../../../../local/runner-host").standardized

final class EntryTests: XCTestCase {
  func testCompiledTableIsTheJSON() throws {
    let json = try String(contentsOf: hostDir.appendingPathComponent("src/launcher-entries.json"), encoding: .utf8)
    XCTAssertEqual(
      json.trimmingCharacters(in: .whitespacesAndNewlines), entriesJSON.trimmingCharacters(in: .whitespacesAndNewlines),
      "run node apps/desktop/scripts/launcher-entries.mjs")
    XCTAssertEqual(EntryTable.compiled.version, 1)
  }

  func testSharedCases() throws {
    let data = try Data(contentsOf: hostDir.appendingPathComponent("test/fixtures/launcher-entry-cases.json"))
    let doc = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
    let cases = try XCTUnwrap(doc["cases"] as? [[String: Any]])
    XCTAssertGreaterThan(cases.count, 20)
    for c in cases {
      let args = try XCTUnwrap(c["args"] as? [String])
      let got = choose(args)
      if let run = c["run"] as? [Any] {
        let choice = try XCTUnwrap(got, "\(args) should be accepted")
        let script = run.first as? String
        XCTAssertEqual(choice.entry.script, script, "\(args)")
        XCTAssertEqual(choice.scriptArgs, run.dropFirst().compactMap { $0 as? String }, "\(args)")
      } else {
        XCTAssertNil(got, "\(args) should exit 64")
      }
    }
  }

  func testLongArgumentRefused() {
    XCTAssertNil(choose(["login", "--url", "https://e.example.com/" + String(repeating: "a", count: 2100)]))
  }

  func testEveryScriptIsAPlainName() {
    for (name, entry) in EntryTable.compiled.entries {
      guard let script = entry.script else { continue }
      XCTAssertFalse(script.contains("/"), name)
      XCTAssertTrue(script.hasSuffix(".cjs"), "\(name): scripts are CommonJS (spec 45 §1)")
    }
  }
}

final class EnvironmentTests: XCTestCase {
  func testPath() {
    XCTAssertEqual(servicePath(#"{"PATH":"/opt/homebrew/bin:/usr/bin","capturedAt":"x"}"#).path, "/opt/homebrew/bin:/usr/bin")
    XCTAssertNil(servicePath(#"{"PATH":"/usr/bin"}"#).warning)
    for bad in [nil, "nope", #"{"PATH":"bin:/usr/bin"}"#, #"{"PATH":""}"#, #"{"PATH":"/a::/b"}"#, #"{"X":1}"#] {
      let r = servicePath(bad)
      XCTAssertEqual(r.path, defaultPath, bad ?? "nil")
      XCTAssertNotNil(r.warning)
    }
    let long = "{\"PATH\":\"/" + String(repeating: "a", count: 5000) + "\"}"
    XCTAssertEqual(servicePath(long).path, defaultPath)
  }

  func testExactKeys() {
    let env = nodeEnvironment(
      account: Account(home: "/Users/u", user: "u", shell: "/bin/zsh"), tmpdir: "/tmp/x/", path: "/usr/bin",
      root: "/r", bundle: "/r/b", lifelineFd: 5)
    XCTAssertEqual(
      Set(env.keys),
      ["HOME", "USER", "LOGNAME", "SHELL", "TMPDIR", "PATH", "SF_RUNNER_SERVICE", "SF_RUNNER_ROOT", "SF_RUNNER_BUNDLE", "SF_RUNNER_LIFELINE_FD"])
  }
}

final class SealTests: XCTestCase {
  func directory(_ hashes: [String: Data]) -> [String: Any] {
    ["files2": hashes.mapValues { ["hash2": $0] }]
  }

  func testCheckScript() {
    let bytes = Data("console.log(1)".utf8)
    let rd = directory(["Resources/runner/s.cjs": sha256(bytes)])
    XCTAssertNil(checkScript(bytes, relative: "Resources/runner/s.cjs", resourceDirectory: rd))
    XCTAssertNotNil(checkScript(Data("console.log(2)".utf8), relative: "Resources/runner/s.cjs", resourceDirectory: rd))
    XCTAssertNotNil(checkScript(bytes, relative: "Resources/runner/t.cjs", resourceDirectory: rd))
    XCTAssertNotNil(checkScript(bytes, relative: "x", resourceDirectory: [:]))
  }

  func testRequirementAndTeam() {
    XCTAssertTrue(developerIdRequirement(identifier: "a.b", team: "ABCDE12345").hasSuffix("leaf[subject.OU] = \"ABCDE12345\""))
    XCTAssertTrue(isTeamId("ABCDE12345"))
    XCTAssertFalse(isTeamId(""))
    XCTAssertFalse(isTeamId("abcde12345"))
    XCTAssertFalse(isTeamId("ABCDE1234"))
  }
}
