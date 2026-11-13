// Node's environment, built from nothing (spec 45 §1, step 3): nothing the launcher was started
// with reaches Node, so NODE_OPTIONS, NODE_PATH, DYLD_* or anything a plist sets is dropped.
import Foundation

public let defaultPath = "/usr/bin:/bin:/usr/sbin:/sbin"
public let maxPathBytes = 4096

/// The account, as getpwuid gives it.
public struct Account: Equatable {
  public let home: String
  public let user: String
  public let shell: String
  public init(home: String, user: String, shell: String) {
    self.home = home
    self.user = user
    self.shell = shell
  }
}

/// PATH from service-env.json's text (`{ "PATH": …, "capturedAt": … }`), or the default and why.
public func servicePath(_ json: String?) -> (path: String, warning: String?) {
  guard let json else { return (defaultPath, "no service-env.json; using the default PATH") }
  guard let doc = try? JSONSerialization.jsonObject(with: Data(json.utf8)) as? [String: Any],
    let path = doc["PATH"] as? String
  else { return (defaultPath, "service-env.json has no PATH; using the default") }
  if path.utf8.count > maxPathBytes { return (defaultPath, "service-env.json's PATH is over 4 KiB; using the default") }
  let dirs = path.split(separator: ":", omittingEmptySubsequences: false)
  if dirs.isEmpty || dirs.contains(where: { !$0.hasPrefix("/") || $0.contains("\0") }) {
    return (defaultPath, "service-env.json's PATH has a directory that isn't absolute; using the default")
  }
  return (path, nil)
}

/// Every variable Node gets, and nothing else.
public func nodeEnvironment(
  account: Account, tmpdir: String, path: String, root: String, bundle: String, lifelineFd: Int32
) -> [String: String] {
  [
    "HOME": account.home,
    "USER": account.user,
    "LOGNAME": account.user,
    "SHELL": account.shell,
    "TMPDIR": tmpdir,
    "PATH": path,
    "SF_RUNNER_SERVICE": "1",
    "SF_RUNNER_ROOT": root,
    "SF_RUNNER_BUNDLE": bundle,
    "SF_RUNNER_LIFELINE_FD": String(lifelineFd),
  ]
}

/// The runner root: `<home>/Library/Application Support/Software Factory/Runner`.
public func runnerRoot(home: String) -> String {
  "\(home)/Library/Application Support/Software Factory/Runner"
}

/// The runner's state dir, as runner-host's default (the launcher passes no override through).
public func stateDir(home: String) -> String {
  "\(home)/.local/state/software-factory/runner"
}

/// The legacy plist the Login Items switch is read for.
public func plistPath(home: String) -> String {
  "\(home)/Library/LaunchAgents/com.software-factory.runner.plist"
}
