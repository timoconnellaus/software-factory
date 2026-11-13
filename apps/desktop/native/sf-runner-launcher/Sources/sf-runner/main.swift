// sf-runner: SF Runner.app's main executable, the launcher (spec 45 §1, ADR 0643). On every start,
// before anything else, it finds its own bundle from its own code object, checks the running code
// and the whole bundle on disk (resources, nested code, every architecture) against the Developer
// ID requirement with the compiled-in Team ID, and refuses (exit 78) on any failure. Then it runs
// one of the fixed entries in launcher-entries.json, never a path: it reads the entry's script,
// checks those bytes against the seal it just validated, and hands Node exactly those bytes on a
// pipe (`/dev/fd/4`), with an environment built from nothing. It spawns Node (not exec) and stays
// its parent, so it remains the responsible process TCC and Login Items name.
import Darwin
import Foundation
import LauncherCore
import Security
import ServiceManagement

let scriptFd: Int32 = 4
let lifelineFd: Int32 = 5

func say(_ line: String) {
  FileHandle.standardError.write(Data("sf-runner launcher: \(line)\n".utf8))
}

func accountInfo() -> Account {
  guard let pw = getpwuid(getuid()) else { say("no passwd entry for this uid"); exit(LauncherExit.refused.rawValue) }
  return Account(home: String(cString: pw.pointee.pw_dir), user: String(cString: pw.pointee.pw_name), shell: String(cString: pw.pointee.pw_shell))
}

let account = accountInfo()

/// Records why this start was refused (the log, and `<stateDir>/service/launch-refused.json`) and
/// exits 78: the guard and the app treat that as "this version is untrustworthy".
func refuse(_ reason: String, bundle: String? = nil) -> Never {
  say("refused: \(reason)")
  let dir = stateDir(home: account.home) + "/service"
  try? FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
  let record: [String: Any] = [
    "at": ISO8601DateFormatter().string(from: Date()), "reason": reason, "bundle": bundle ?? NSNull(),
  ]
  if let data = try? JSONSerialization.data(withJSONObject: record, options: [.sortedKeys]) {
    try? data.write(to: URL(fileURLWithPath: dir + "/launch-refused.json"), options: .atomic)
  }
  exit(LauncherExit.refused.rawValue)
}

func cfError(_ e: Unmanaged<CFError>?) -> String {
  guard let e = e?.takeRetainedValue() else { return "no detail" }
  return (CFErrorCopyDescription(e) as String?) ?? "no detail"
}

// MARK: The command line (exit 64 before touching anything).
let args = Array(CommandLine.arguments.dropFirst())
guard let choice = choose(args) else {
  say("usage: sf-runner [entry] [arguments]; the entries are in Contents/Resources/launcher-entries.json")
  exit(LauncherExit.usage.rawValue)
}

// MARK: 1. Find its own bundle from its own code object.
var selfCode: SecCode?
var selfStatic: SecStaticCode?
var selfURL: CFURL?
guard SecCodeCopySelf([], &selfCode) == errSecSuccess, let selfCode,
  SecCodeCopyStaticCode(selfCode, [], &selfStatic) == errSecSuccess, let selfStatic,
  SecCodeCopyPath(selfStatic, [], &selfURL) == errSecSuccess, let selfURL
else { refuse("can't find its own code object") }
guard let resolved = realpath((selfURL as URL).path, nil) else { refuse("can't resolve its own bundle path") }
let bundle = String(cString: resolved)
free(resolved)
guard bundle.hasSuffix(".app") else { refuse("not running from a bundle (\(bundle))", bundle: bundle) }

// MARK: 2. Check the running code and the whole bundle on disk.
let team = compiledTeam
let dev = team.isEmpty
if !dev && !isTeamId(team) { refuse("the compiled-in Team ID isn't one", bundle: bundle) }

func requirement(_ identifier: String) -> SecRequirement? {
  if dev { return nil }
  var req: SecRequirement?
  guard SecRequirementCreateWithString(developerIdRequirement(identifier: identifier, team: team) as CFString, [], &req)
    == errSecSuccess
  else { refuse("can't build the requirement", bundle: bundle) }
  return req
}

let strict = SecCSFlags(rawValue: kSecCSStrictValidate | kSecCSCheckNestedCode | kSecCSCheckAllArchitectures)
let started = clock_gettime_nsec_np(CLOCK_UPTIME_RAW)
let bundleReq = requirement(bundleIdentifier)
if SecCodeCheckValidity(selfCode, [], bundleReq) != errSecSuccess { refuse("the running code doesn't check out", bundle: bundle) }
var err: Unmanaged<CFError>?
if SecStaticCodeCheckValidityWithErrors(selfStatic, strict, bundleReq, &err) != errSecSuccess {
  refuse("the bundle's seal doesn't check out: \(cfError(err))", bundle: bundle)
}

/// Signing information, with the resource directory this object validated.
func signingInfo(_ code: SecStaticCode) -> [String: Any] {
  var info: CFDictionary?
  let flags = SecCSFlags(rawValue: kSecCSSigningInformation | kSecCSContentInformation | kSecCSInternalInformation)
  guard SecCodeCopySigningInformation(code, flags, &info) == errSecSuccess, let info = info as? [String: Any] else {
    refuse("can't read its signing information", bundle: bundle)
  }
  return info
}

let info = signingInfo(selfStatic)
guard info[kSecCodeInfoIdentifier as String] as? String == bundleIdentifier else {
  refuse("the bundle isn't \(bundleIdentifier)", bundle: bundle)
}
if dev {
  say("unsigned build: accepting an ad-hoc signature")
} else if info[kSecCodeInfoTeamIdentifier as String] as? String != team {
  refuse("signed by another team", bundle: bundle)
}

let nodePath = bundle + "/Contents/Helpers/node"
var nodeStatic: SecStaticCode?
guard SecStaticCodeCreateWithPath(URL(fileURLWithPath: nodePath) as CFURL, [], &nodeStatic) == errSecSuccess, let nodeStatic
else { refuse("no Contents/Helpers/node", bundle: bundle) }
let nodeReq = requirement(nodeIdentifier)
// The nested check above already hashed Node's pages; this checks its own signature against its
// requirement without hashing them again (the started process is checked again after the spawn).
if SecStaticCodeCheckValidityWithErrors(nodeStatic, SecCSFlags(rawValue: kSecCSDoNotValidateExecutable), nodeReq, &err)
  != errSecSuccess
{
  refuse("Contents/Helpers/node doesn't check out: \(cfError(err))", bundle: bundle)
}
guard signingInfo(nodeStatic)[kSecCodeInfoIdentifier as String] as? String == nodeIdentifier else {
  refuse("Contents/Helpers/node isn't \(nodeIdentifier)", bundle: bundle)
}
let checkedIn = Double(clock_gettime_nsec_np(CLOCK_UPTIME_RAW) - started) / 1e6
if ProcessInfo.processInfo.environment["SF_RUNNER_LAUNCHER_TIMING"] == "1" {
  // Only a measurement (spec 45 §1, Cost); nothing the launcher does depends on its environment.
  say(String(format: "checked the bundle in %.1f ms", checkedIn))
}

// MARK: An entry the launcher answers itself.
guard let script = choice.entry.script else {
  // login-item-status: the Login Items switch for our legacy plist (spec 45 §2).
  let status = SMAppService.statusForLegacyPlist(at: URL(fileURLWithPath: plistPath(home: account.home)))
  switch status {
  case .notRegistered: print("notRegistered")
  case .enabled: print("enabled")
  case .requiresApproval: print("requiresApproval")
  case .notFound: print("notFound")
  @unknown default: print("unknown")
  }
  exit(0)
}

// MARK: 3. Node's environment, from nothing.
let root = runnerRoot(home: account.home)
let serviceEnv = try? String(contentsOfFile: root + "/service-env.json", encoding: .utf8)
let (path, pathWarning) = servicePath(serviceEnv)
if let pathWarning { say(pathWarning) }
var tmpBuf = [CChar](repeating: 0, count: Int(PATH_MAX))
let tmpdir = confstr(_CS_DARWIN_USER_TEMP_DIR, &tmpBuf, tmpBuf.count) > 0 ? String(cString: tmpBuf) : "/tmp/"
let env = nodeEnvironment(account: account, tmpdir: tmpdir, path: path, root: root, bundle: bundle, lifelineFd: lifelineFd)

// MARK: 5. The script: read it, check those bytes against the validated seal.
let relative = "Resources/runner/\(script)"
let fd = open(bundle + "/Contents/" + relative, O_RDONLY | O_NOFOLLOW | O_CLOEXEC)
if fd < 0 { refuse("can't open \(relative)", bundle: bundle) }
var st = stat()
if fstat(fd, &st) != 0 || (st.st_mode & S_IFMT) != S_IFREG { refuse("\(relative) isn't a regular file", bundle: bundle) }
let bytes = FileHandle(fileDescriptor: fd, closeOnDealloc: true).readDataToEndOfFile()
guard let directory = info["ResourceDirectory"] as? [String: Any] else { refuse("no resource directory in the seal", bundle: bundle) }
if let why = checkScript(bytes, relative: relative, resourceDirectory: directory) { refuse(why, bundle: bundle) }

// MARK: 6. Spawn Node with exactly those bytes on a pipe, and stay its parent.
func pipePair() -> (r: Int32, w: Int32) {
  var p: [Int32] = [0, 0]
  guard pipe(&p) == 0 else { say("pipe failed"); exit(71) }
  _ = fcntl(p[0], F_SETFD, FD_CLOEXEC)
  _ = fcntl(p[1], F_SETFD, FD_CLOEXEC)
  return (p[0], p[1])
}
let scriptPipe = pipePair()
let lifeline = pipePair()

var actions: posix_spawn_file_actions_t?
posix_spawn_file_actions_init(&actions)
for keep in [STDIN_FILENO, STDOUT_FILENO, STDERR_FILENO] + (choice.entry.fd3 ? [3] : []) {
  posix_spawn_file_actions_addinherit_np(&actions, keep)
}
posix_spawn_file_actions_adddup2(&actions, scriptPipe.r, scriptFd)
posix_spawn_file_actions_adddup2(&actions, lifeline.r, lifelineFd)

var attrs: posix_spawnattr_t?
posix_spawnattr_init(&attrs)
// Nothing open in Node but what is named above.
posix_spawnattr_setflags(&attrs, Int16(POSIX_SPAWN_CLOEXEC_DEFAULT | POSIX_SPAWN_SETSIGDEF | POSIX_SPAWN_SETSIGMASK))
var defaults = sigset_t()
sigfillset(&defaults)
posix_spawnattr_setsigdefault(&attrs, &defaults)
var empty = sigset_t()
sigemptyset(&empty)
posix_spawnattr_setsigmask(&attrs, &empty)

let forwarded: [Int32] = [SIGTERM, SIGINT, SIGUSR2, SIGHUP]
for sig in forwarded { signal(sig, SIG_IGN) }

let argv = [nodePath, "--disable-sigusr1", "--no-addons", "/dev/fd/\(scriptFd)"] + choice.scriptArgs
let cArgv = argv.map { strdup($0) } + [nil]
let cEnv = env.sorted { $0.key < $1.key }.map { strdup("\($0.key)=\($0.value)") } + [nil]
var child: pid_t = 0
let spawned = posix_spawn(&child, nodePath, &actions, &attrs, cArgv, cEnv)
close(scriptPipe.r)
close(lifeline.r)
if spawned != 0 {
  // A refused launch constraint shows up here or as SIGKILL; either way Node didn't run.
  say("can't start Contents/Helpers/node: \(String(cString: strerror(spawned)))")
  exit(LauncherExit.refused.rawValue)
}

// The child's running code must be the Node just checked (spec 45 §1, step 6).
var guest: SecCode?
let attributes = [kSecGuestAttributePid: child] as CFDictionary
if SecCodeCopyGuestWithAttributes(nil, attributes, [], &guest) != errSecSuccess || guest == nil
  || SecCodeCheckValidity(guest!, [], nodeReq) != errSecSuccess
  || (dev && signingInfoIdentifier(guest!) != nodeIdentifier)
{
  kill(child, SIGKILL)
  refuse("the started Node isn't the one checked", bundle: bundle)
}

func signingInfoIdentifier(_ code: SecCode) -> String? {
  var s: SecStaticCode?
  guard SecCodeCopyStaticCode(code, [], &s) == errSecSuccess, let s else { return nil }
  var info: CFDictionary?
  guard SecCodeCopySigningInformation(s, [], &info) == errSecSuccess else { return nil }
  return (info as? [String: Any])?[kSecCodeInfoIdentifier as String] as? String
}

// Feed the checked bytes, then close: Node reads the script once, to EOF.
let writer = Thread {
  bytes.withUnsafeBytes { raw in
    var off = 0
    while off < raw.count {
      let n = write(scriptPipe.w, raw.baseAddress! + off, raw.count - off)
      if n < 0 { if errno == EINTR { continue } else { break } }
      off += n
    }
  }
  close(scriptPipe.w)
}
writer.start()

var sources: [DispatchSourceSignal] = []
for sig in forwarded {
  let source = DispatchSource.makeSignalSource(signal: sig, queue: .main)
  source.setEventHandler { kill(child, sig) }
  source.resume()
  sources.append(source)
}

let exitSource = DispatchSource.makeProcessSource(identifier: child, eventMask: .exit, queue: .main)
exitSource.setEventHandler {
  var status: Int32 = 0
  while waitpid(child, &status, 0) < 0 && errno == EINTR {}
  // The lifeline's write end closes with this process.
  let signalled = status & 0x7f
  exit(signalled == 0 ? (status >> 8) & 0xff : 128 + signalled)
}
exitSource.resume()
// The child may have exited before the source was armed.
var early: Int32 = 0
if waitpid(child, &early, WNOHANG) == child {
  let signalled = early & 0x7f
  exit(signalled == 0 ? (early >> 8) & 0xff : 128 + signalled)
}
_ = lifeline.w
dispatchMain()
