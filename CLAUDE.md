# CLAUDE.md — `fit`

A strength-training tracker that replaces a spreadsheet implementation of the
Candito 6-Week Strength Program. One user, three environments, one AWS account,
zero idle compute.

The **why** for every structural choice lives in [`ADRs.md`](ADRs.md), and each
ADR carries a **Lens** — a forward rule. Read the Lens index before asking a
design question; most are already answered.

## Orientation

| I want to… | Go to |
|---|---|
| Understand the training program itself | [`docs/domain-model.md`](docs/domain-model.md) |
| Understand the deployed shape | [`ARCHITECTURE.md`](ARCHITECTURE.md) |
| Change infrastructure | [`infra/CLAUDE.md`](infra/CLAUDE.md) |
| Stand up a fresh account | [`infra/bootstrap/README.md`](infra/bootstrap/README.md) |
| See what is undecided | [`docs/questions/`](docs/questions/) |

## The inner loop

```sh
make fix ci        # format, lint, typecheck, unit tests — the gate before pushing
make dev           # DynamoDB Local + API + SPA, all real handlers
make e2e           # Playwright against the local stack
make tf-check      # fmt-check + validate, no cloud, no state
```

`make ci` is free, offline and deterministic. Anything that spends money or
touches AWS is a **sibling** target, never a dependency of `ci`.

## Invariants

- **Never `cd`.** Every command runs from the repo root; that is what the
  Makefile is for. Use `bun run --cwd`, `uv run --directory`, `terraform -chdir`.
- **Temporary files go in `tmp/`**, project-local. Never `/tmp`, never
  `tempfile.mkdtemp()`.
- **No prescribed weight is ever persisted** (ADR-0001). If you are about to
  write a computed weight to DynamoDB, stop.
- **Logging never requires a plan** (ADR-0036). A `LoggedExerciseActivity` needs
  an exercise, a rep count and a timestamp. Any change that makes `blockId`,
  `week` or `sessionRef` mandatory has inverted the model.
- **A prescription and a log are different types.** If you find yourself adding
  an optional field because a value is sometimes-a-plan-and-sometimes-a-fact,
  that is two types.
- **One rollout, every program** (ADR-0037). Percentages, rounding and unit
  increments resolve in `rolloutBlock` and nowhere else. A branch on `programId`
  inside the resolver is the bug this rule exists to prevent.
- **A block stores `programId` and `parameters`, and nothing else.** A schema
  field named after a specific lift (`bench`, `squat`) is a program's parameter
  that escaped into the schema.
- **Shape changes happen on READ** (ADR-0038). The API role has no `UpdateItem`
  on history, so a stored-shape change is an adapter in `api/src/legacy.ts`, not
  a backfill. Prove it with an equivalence test, never an inspection.
- **No `resource` blocks in `infra/stacks/`.** `grep -rn '^resource' infra/stacks/`
  must return nothing — stacks compose modules and own naming; modules own
  resources.
- **CI is the only actor that runs Terraform** (ADR-0006). "Apply it locally to
  check" is never the answer.
- **`x-auth-*` headers are stripped inbound before anything else** in the edge
  authenticator (ADR-0009). A forgotten strip is a privilege escalation.
- **Requirements do not degrade** — only environments do. If a dependency is
  missing, crash loudly with a message naming it. No `try/except ImportError`
  that silently disables a feature.

## Known gotchas

- **`config.json` for the edge function is not on disk.** Terraform's
  `archive_file` synthesizes it from `local.edge_config` at plan time, because
  Lambda@Edge has no environment variables (ADR-0017). Adding a source file to
  the edge bundle means editing the module's `main.tf` — a file that is imported
  but not listed passes every local test and then fails at the edge with a
  module-resolution error.
- **The Terraform backend is partial.** Every local Terraform command reads
  whichever environment was last initialised. This is why `tf-check` uses
  `-backend=false` and why applying locally is forbidden.
- **Cost-allocation tags are not retroactive.** A resource created untagged is
  permanently unattributable in Cost Explorer. `default_tags` on every provider
  is load-bearing, not cosmetic (ADR-0014).
- **`reference/` is gitignored on purpose.** It holds the source spreadsheet,
  which contains personal body metrics. Its *structure* is documented in
  `docs/domain-model.md`; its *data* stays local.
- **13-month hot window, not 12** (ADR-0012), so a year-on-year comparison never
  has to touch Athena.

## Conventions

- Resource names: `fit-{env}-{thing}`. SSM: `/fit/{env}/{key}`. State keys:
  `{stack}/{env}.tfstate`.
- Environments are `dev`, `test`, `prod` → `fit-dev.jpeak.ai`,
  `fit-test.jpeak.ai`, `fit.jpeak.ai`.
- TypeScript for anything in the request path; Python only for the Parquet
  age-out job and analysis helpers (ADR-0019).
