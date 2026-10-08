# AGENTS.md

This is a StartOS service-package repository — it builds a `.s9pk` for StartOS.

Develop it inside a StartOS packaging workspace created by `start-cli s9pk init-workspace`,
which provides the packaging guide and agent context one level up. If you're reading this in a
bare clone with no workspace, the full guide is at <https://docs.start9.com/packaging>.

**Start every task at the recipe index** — `../start-technologies/projects/start-sdk/docs/src/recipes.md`
(or <https://docs.start9.com/packaging/recipes.html>). It maps an intent ("prompt the user to create
admin credentials", "expose a web UI") to the constructs, the reference pages, and a named production
package to copy. Find the recipe before you read this package's neighbours: a package you reach by
grepping may be non-conformant, and the recipe outranks it.

Freshly scaffolded? Work the
[New Package Checklist](../start-technologies/projects/start-sdk/docs/src/new-package-checklist.md)
(or <https://docs.start9.com/packaging/new-package-checklist.html>) from top to bottom. It is a
guide page, not a file in this repo — read it, don't copy it in.

Keep `README.md` (technical reference for an AI support or administering agent) and
`instructions.md` (end-user docs) in sync with your changes. This file restates neither:
whoever changes the package has both, so it carries only what they don't — repo mechanics,
a change that looks right and is not, where the next thing gets added, a naming trap, a
build or test invocation particular to this repo.

**Fix a defect you spot rather than reporting it** — you have the package open and the
context to be sure. File **a GitHub issue on this repo** only when the call isn't yours to
make: you can't pin the cause down, two defensible fixes exist, or it's too large to ride on
the work in hand. An open issue is a report, not a queue — implement one when you're asked
to or when it's labelled `Approved`, then close it with `Closes #<n>`.

Don't record work in the repo instead: no `TODO.md`, no `NOTES.md`, no `PLAN.md`. What you
verified, tried, and decided belongs in the commit message and the PR body.

## This repo

- **Never rewrite a stored WireGuard config**, not even to strip markers an earlier version wrote. The node's clearnet-vpn task accepts the stored string trimmed, as the StartOS form submits it, and verbatim only as a fallback, so any change inside the config changes both entries and re-raises it on every upgraded box.
- **Hold bridge.py's `meta_lock` (`metaLockFor(effects)` in `startos/metaLock.ts`) for every read-modify-write of `tunnelsats-meta.json`, `config.json` or the conf file**, because both runtimes rewrite them. Hold it around the file read and write only; never await a bridge.py exec, an API request or a task call under it.
- **Don't reintroduce the retired host-gateway model** (config markers, system gateways, routing node egress through a host gateway), and keep kill-switch claims scoped to the node versions in `NODE_VERSION_RANGES` — never "can never leak" or "100% private".
- **The package build runs none of the tests.** `npm run test:all` (TypeScript, Python, BATS) needs `python3` and wireguard-tools' `wg`; CI's test job in `build.yml` is what gates them.
