// The Team ID the release compiles in (spec 45 §1, step 2). Empty in a dev build: the launcher
// then accepts an ad-hoc signature and logs `unsigned build`. scripts/runner-app.mjs writes the
// release's value into a copy of this package; this file always stays empty.
let compiledTeam = ""
