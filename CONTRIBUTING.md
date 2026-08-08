# Contributing

## Before anything else

Read [`ADRs.md`](ADRs.md) — or at least its index. Every entry carries a
**Lens**: the forward rule it projects. Most design questions this repository
raises are already answered there, and a change that contradicts a Lens needs a
new ADR rather than an exception.

If a genuine ambiguity survives that check, it goes in
[`docs/questions/`](docs/questions/) as `Q{NN}-{stub}.md` with the assumption
you took, and you keep going. Blocking on a question is the last resort, not the
first (ADR-0020).

## The loop

```sh
make install
make dev              # DynamoDB Local + API + SPA
make token ENV=local  # a session, so you can sign in
make fix ci           # the gate — run before every push
```

`make ci` is free, offline and deterministic: format, lint, typecheck across
every workspace, unit tests, and `terraform validate`. It must be green before
you push. If it is green locally and red in CI, that is a bug in `make ci` and
fixing it is part of the change.

Sibling targets that cost time or money — never dependencies of `ci`:

```sh
make e2e ENV=local    # Playwright
make smoke ENV=dev    # every API route of a deployed environment
make diagrams         # Mermaid contrast + complexity gates
make shots ENV=local  # screenshot every page, light and dark
```

## Invariants

These are not style preferences. A change that breaks one is wrong even if it
works.

- **Never `cd`.** Every command runs from the repository root — that is what the
  Makefile is for. `bun run --cwd`, `uv run --directory`, `terraform -chdir`.
- **Temporary files go in `tmp/`**, project-local. Never `/tmp`.
- **No prescribed weight is persisted.** If you are about to write a computed
  weight to DynamoDB, stop and re-read ADR-0001.
- **No `resource` blocks in `infra/stacks/`.** CI checks it; so should you.
- **CI is the only actor that runs Terraform.** "Apply it locally to check" is
  never the answer — a partial backend means local commands silently target
  whichever environment was initialised last.
- **The edge strips `x-auth-*` before anything else.** Moving that line down is
  a privilege escalation, not a refactor.
- **Requirements do not degrade; environments do.** A missing dependency crashes
  loudly with a message naming it. No `try/except ImportError` that quietly
  disables a feature.

## Tests

`bun:test`, and **no mocks, stubs or spies**. Test real code against real
dependencies — DynamoDB Local, a real subprocess, a real browser. A mock only
ever proves you guessed the interface correctly.

If something genuinely cannot be tested without a mock, do not write the test.
An honest gap is better than a green tick that means nothing.

Every table-driven test gets **one row per case**. A single row with six columns
tests the first column and silently ignores the rest — which is how a suite
stops testing without anyone noticing.

## Changing infrastructure

Read [`infra/CLAUDE.md`](infra/CLAUDE.md) first; it is the gotcha list.

```sh
make tf-check   # fmt-check + validate. No cloud, no state.
```

Then push and read the plan CI posts. That plan is the gate, and it must show
only what you intended. A stack that has never been applied in an environment
will fail its plan there — that is the cold-start condition, not your change
(ADR-0022).

## Promotion

Nothing is deployed by hand. The Git event decides:

| You do | Result |
|---|---|
| Draft pull request | plan across dev, test, prod. No apply. |
| Mark ready for review | `apply / dev` |
| Merge to `main` | `apply / test` |
| Push a `v*` tag | `apply / prod` |

So: open drafts early. A draft PR is a free, zero-risk report of what your
change would do to every environment.

## Commits and pull requests

Explain **why**, not what — the diff already says what. The most valuable commit
message in this repository is the one that names the failure mode a change
prevents, because that is the thing a reader six months from now cannot
reconstruct.

Pull request descriptions should say what was verified and how, and should name
any defect the work surfaced. A change that found a bug is more informative than
one that did not.

## Adding a document

Canonical locations, per the repository's own convention:

| Document | Lives at |
|---|---|
| Structural decision | `ADRs.md`, with a Lens |
| Open question | `docs/questions/Q{NN}-{stub}.md` |
| Domain explanation | `docs/` |
| Agent-facing operating notes | the nearest `CLAUDE.md` |
| Vocabulary | [`GLOSSARY.md`](GLOSSARY.md) |

Never restate one in another. `README.md` links; `ADRs.md` reasons; `CLAUDE.md`
warns; `GLOSSARY.md` defines.
