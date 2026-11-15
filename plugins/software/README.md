# The software plugin

An example plugin for the new core (spec 70): pull requests for the items of a project that has a
GitHub repository. It is plain JavaScript in the plugin contract's shape
(`packages/plugins/README.md`); this folder is not a workspace package and nothing builds it.

What it does, and nothing else:
- **`runEnded`**: when an agent's run ends `done` and the item's branch has a head, it opens a pull
  request from the item's branch (`factory/flow/<key>-<number>`) into the default branch unless
  one is open, keeps its number in the item's `pr` field, and adds a card: `#<n> <title>`,
  `+a −b`, the check runs on the head, and a link.
- **`leaving`**: an item can't leave a status whose name contains "review" while a check run on the
  pull request's head has failed or is still running. The refusal names the checks.
- **`entered`**: when the item enters "Merged" or "Shipped", its open pull request is merged with a
  merge commit and a card says so. If GitHub refuses, the item stops with GitHub's message and can
  be retried.

It uses only the built-in `github` gateway, so the org must have connected GitHub and the project
must have a repository (the project's Settings tab, or `flow.project.setRepository`).

## Install
From the CLI, in the org:

```sh
sf call flow.plugin.save "{\"orgId\":\"<org id>\",\"name\":\"software\",\"request\":\"Pull requests for software projects.\",\"code\":$(node -e 'process.stdout.write(JSON.stringify(require("fs").readFileSync("plugins/software/plugin.js","utf8")))')}"
```

Or ask the Builder in Chat: "Install the software plugin from plugins/software/plugin.js in the
repository" and paste the file. Saving it again replaces it; `flow.plugin.setEnabled` turns it off.

The engine's `apps/engine/test/flow-software.test.ts` walks it end to end against a fake GitHub.
