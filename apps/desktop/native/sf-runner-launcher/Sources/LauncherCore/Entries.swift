// The entry table and its argument grammar (spec 45 §1, Entry points). The table is
// local/runner-host/src/launcher-entries.json, compiled in as EntriesJSON.swift; the CLI reads the
// same file (launcher-entries.ts there), and both run the same cases
// (local/runner-host/test/fixtures/launcher-entry-cases.json).
import Foundation

/// The launcher's exit codes besides the child's own.
public enum LauncherExit: Int32 {
  /// A malformed command line: an unknown entry, a flag or value outside the entry's grammar.
  case usage = 64
  /// The bundle failed its check (refused: this version is untrustworthy, spec 45 §5).
  case refused = 78
}

public struct Form: Decodable, Equatable {
  public let words: [String]
  public let flags: [String: String?]
  public let required: [String]
  public let exclusive: [[String]]
  public let requires: [String: String]

  enum CodingKeys: String, CodingKey { case words, flags, required, exclusive, requires }

  public init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    words = try c.decode([String].self, forKey: .words)
    // A switch is `null` in the JSON: decode the dictionary by hand to keep it.
    var flags: [String: String?] = [:]
    if c.contains(.flags) {
      let raw = try c.decode([String: OptionalString].self, forKey: .flags)
      for (k, v) in raw { flags[k] = v.value }
    }
    self.flags = flags
    required = try c.decodeIfPresent([String].self, forKey: .required) ?? []
    exclusive = try c.decodeIfPresent([[String]].self, forKey: .exclusive) ?? []
    requires = try c.decodeIfPresent([String: String].self, forKey: .requires) ?? [:]
  }
}

private struct OptionalString: Decodable {
  let value: String?
  init(from decoder: Decoder) throws {
    let c = try decoder.singleValueContainer()
    value = c.decodeNil() ? nil : try c.decode(String.self)
  }
}

public struct Entry: Decodable, Equatable {
  /// The script under Contents/Resources/runner, or nil for an entry the launcher answers itself.
  public let script: String?
  public let fixed: [String]
  /// Whether the child gets the caller's fd 3 (the check child's report pipe).
  public let fd3: Bool
  public let forms: [Form]

  enum CodingKeys: String, CodingKey { case script, fixed, fd3, forms }

  public init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    script = try c.decodeIfPresent(String.self, forKey: .script)
    fixed = try c.decode([String].self, forKey: .fixed)
    fd3 = try c.decodeIfPresent(Bool.self, forKey: .fd3) ?? false
    forms = try c.decode([Form].self, forKey: .forms)
  }
}

public struct EntryTable: Decodable {
  public let version: Int
  public let entries: [String: Entry]

  public static func parse(_ json: String) throws -> EntryTable {
    try JSONDecoder().decode(EntryTable.self, from: Data(json.utf8))
  }

  /// The table compiled into this launcher.
  public static let compiled: EntryTable = {
    do { return try parse(entriesJSON) } catch { fatalError("launcher-entries.json: \(error)") }
  }()
}

/// What an accepted command line runs.
public struct Choice: Equatable {
  public let name: String
  public let entry: Entry
  /// The arguments after the script: the entry's fixed ones, then the caller's, as validated.
  public let scriptArgs: [String]
}

public let maxArgumentBytes = 2048
// `\A` and `\z`, not `^` and `$`: NSRegularExpression's `$` also matches before a final newline, so
// `"m5\n"` would pass here while the CLI's pattern (JavaScript's `$`, no `m` flag) refuses it.
let namePattern = try! NSRegularExpression(pattern: #"\A[A-Za-z0-9._-]{1,64}\z"#)

/// Whether `value` is of the grammar's `type`: `<name>`, `<url>`, or `a|b` (one of those words).
public func valueMatches(_ type: String, _ value: String) -> Bool {
  switch type {
  case "<name>":
    let range = NSRange(value.startIndex..., in: value)
    return namePattern.firstMatch(in: value, range: range) != nil
  case "<url>":
    return isPlainHttpsURL(value)
  default:
    return type.split(separator: "|").contains { String($0) == value }
  }
}

/// An `https:` URL with a host and no user info, at most 2 KiB, nothing but printable ASCII.
public func isPlainHttpsURL(_ value: String) -> Bool {
  guard value.utf8.count <= maxArgumentBytes,
    value.unicodeScalars.allSatisfy({ $0.value > 0x20 && $0.value < 0x7f }),
    let c = URLComponents(string: value), c.scheme == "https",
    let host = c.host, !host.isEmpty, c.user == nil, c.password == nil
  else { return false }
  return true
}

/// The entry and script arguments for `args` (the launcher's argv without argv[0]), or nil when
/// the command line is outside the table: then the launcher exits 64.
public func choose(_ args: [String], table: EntryTable = .compiled) -> Choice? {
  if args.contains(where: { $0.utf8.count > maxArgumentBytes }) { return nil }
  let name = args.first ?? ""
  // An empty first argument is not the guard: only no arguments at all is.
  if args.first == "" { return nil }
  guard let entry = table.entries[name] else { return nil }
  let rest = Array(args.dropFirst(args.isEmpty ? 0 : 1))
  for form in entry.forms {
    if let parsed = match(rest, form) { return Choice(name: name, entry: entry, scriptArgs: entry.fixed + parsed) }
  }
  return nil
}

func match(_ args: [String], _ form: Form) -> [String]? {
  guard args.count >= form.words.count else { return nil }
  for (word, arg) in zip(form.words, args) {
    if word.hasPrefix("<") {
      if !valueMatches(word, arg) { return nil }
    } else if word != arg {
      return nil
    }
  }
  var seen = Set<String>()
  var i = form.words.count
  while i < args.count {
    let flag = args[i]
    guard let type = form.flags[flag], !seen.contains(flag) else { return nil }
    seen.insert(flag)
    if let type {
      guard i + 1 < args.count, valueMatches(type, args[i + 1]) else { return nil }
      i += 2
    } else {
      i += 1
    }
  }
  if form.required.contains(where: { !seen.contains($0) }) { return nil }
  if form.exclusive.contains(where: { group in group.filter(seen.contains).count > 1 }) { return nil }
  if form.requires.contains(where: { seen.contains($0.key) && !seen.contains($0.value) }) { return nil }
  return args
}
