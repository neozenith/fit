# CLAUDE.md: `infra/`

Operating manual and gotcha list for the infrastructure. The **why** is in
[`../ADRs.md`](../ADRs.md); [`../ARCHITECTURE.md`](../ARCHITECTURE.md) is the
shape. This file is what breaks and how.

## The seam

**Modules own resources. Stacks own naming, environment selection and wiring.**

Check yourself before claiming a change is done:

```sh
grep -rn '^resource' infra/stacks/   # must return nothing
make tf-check                        # fmt-check + validate. No cloud, no state.
```

Be precise about the rule, because the looser version is wrong: a stack is
**not** "only locals and module calls". Stacks legitimately contain `locals`,
`data` lookups, `provider`, `terraform`, `variable`, `output` and `moved`
blocks. The invariant is about `resource`, and nothing else.

Then push. **CI plans and applies; you don't** (ADR-0006). The plan CI posts is
the real gate, and it must show only what you intended.

## Layout

```
bootstrap/     CloudFormation. The ONE layer a human runs.
entra/         The EntraID app registration. Different cloud, different identity.
google/        Seeds the Google OAuth secret. Same reason, less automation —
               gcloud cannot create a web client, so the console does that part.
modules/       identity · data · api · edge · archive · finops
stacks/        one directory per stack, each with backends/{env}.config
```

## Standing up a new environment

Stacks read each other through SSM, so a downstream stack cannot **plan** until
its upstream has **applied**. On a warm environment that is invisible; on an
empty one, `api` and `edge` fail with "couldn't find resource".

Use the cold-start workflow (ADR-0022) — never a local apply:

```sh
gh workflow run cold-start.yml -f environment=dev
```

It applies `identity → data → api → edge → archive → frontend → tags`, one job
per stack, chained with `needs`.

## Known gotchas

- **`config.json` for the edge function is not on disk.** Terraform's
  `archive_file` synthesizes it from `local.edge_config` at plan time, because
  Lambda@Edge has no environment variables. Adding a source file to that bundle
  means editing `modules/edge/main.tf` — a module that is imported but not
  listed there passes every local test and then fails at the edge with a
  resolution error.
- **The backend is partial and filled at `init`.** Every local Terraform command
  reads whichever environment was last initialised. That is why `tf-check` uses
  `-backend=false`, and why a local apply is forbidden rather than merely
  discouraged.
- **The `api`→`edge` invoke permission lives in `edge`, deliberately.** It needs
  both the function name and the distribution ARN. In `api` that would make the
  two stacks mutually dependent, escapable only by widening the permission to
  every distribution in the account. Do not "tidy" it back.
- **`price_class` is `PriceClass_All`, and that is not an oversight.**
  `PriceClass_100` is cheapest and does **not** cover Australia, which is where
  the only user is.
- **The archive role has no `PutItem`.** That is the append-only invariant
  (ADR-0013) enforced in IAM rather than trusted to the handler. Do not add it
  to "make the job idempotent" — it already is.
- **Adding a table means editing TWO files, and the drift is invisible until
  production.** `modules/data/main.tf` creates it; `stacks/api/main.tf` carries a
  **literal** list of table names, one SSM read each, to build the API role's IAM
  policy. That literal cannot be derived — `for_each` over an SSM value is
  unknown at plan time and would make a cold environment unplannable (ADR-0022).

  Drift between them **plans clean and applies clean**. The symptom arrives at
  runtime as `502` with
  `AccessDeniedException … not authorized to perform: dynamodb:Query`, on exactly
  the routes touching the new table, with every other route green. `make ci` now
  fails on the mismatch (`make tf-tables`) and names which list is short.
- **A cross-stack release is THREE red workflows for ONE cause, in every
  environment.** Adding a table taught this the long way in v0.11.0: `TF api`
  fails its plan on the parameter `data` has only just created, and both
  `Deploy frontend` and `Verify` fail their smoke on routes the un-applied API
  does not serve yet. Three reds, one root cause, one fix — let `data` finish,
  re-run `TF api`, then re-run the two smoke workflows. Read a red tag run by
  cause, not by count.
- **`Verify`'s browser suite races CloudFront invalidation.** Re-running it in
  the same breath as `Deploy frontend` fails with `element(s) not found` on
  whichever pages the change touched, because the edge is still serving the
  previous bundle. Re-run it *after* the frontend deploy reports success, not
  alongside it.
- **The Playwright suite is flaky against a deployed environment at default
  concurrency, and is not flaky serially.** Parallel workers each wake a cold
  Lambda that pays DuckDB's ~7s initialisation, so a different handful of tests
  times out on every run while each one passes in isolation. `--workers=1` is
  the honest way to read a deployed result: 45/45 dev, 44/44 test, 37/37 prod on
  the release that produced this note.
- **The DuckDB layer cannot be built by `bun install`.** The native binding is
  an *optional dependency* selected by `os`/`cpu`, so any ordinary install
  resolves for the build host — a macOS laptop or an x86 runner — and publishes
  a layer that dies at cold start with a module-resolution error that never
  says "architecture". `tools/build-duckdb-layer.sh` uses `npm --os --cpu
  --libc --include=optional`; **`--include=optional` is the load-bearing flag**,
  because without it npm resolves *nothing* for either platform, exits 0, and
  produces 1.6MB of JavaScript with no binary in it.
- **`httpfs` and `aws` are baked into that layer, not installed at runtime.**
  Only `parquet` is statically linked into DuckDB. The default behaviour is to
  download the others from extensions.duckdb.org into `$HOME`, which on Lambda
  is read-only — so the first S3 read fails in the deployed environment and
  nowhere else. The layer ships them under `/opt/duckdb-extensions/{version}/
  {platform}/`, and the API sets `autoinstall_known_extensions = false` so a
  missing bake is a loud failure rather than a silent network call.
- **An empty Parquet glob is an IO *error*, not an empty result.** `read_parquet`
  raises when nothing matches, which is the normal state of an account whose
  first CUR has not landed. `queryParquet` decides that case from a `glob()`
  listing, never from the text of the error — classifying a vendor's error prose
  is exactly what ADR-0025 deleted along with Athena.
- **The pyarrow layer ARN is pinned to an exact version.** A floating `:latest`
  would change the Parquet writer under a job whose entire value is that it does
  not lose data.
- **Cost-allocation tags are not retroactive, and are a two-pass operation.** A
  key is only activatable once AWS has observed it on a real resource, so the
  bootstrap run reports "not activatable yet" on an empty account and the
  cold-start workflow activates them at the end. Spend before activation is
  unattributable forever.
- **The OIDC provider is usually pre-existing.** An account holds only one per
  issuer URL. The bootstrap discovers and adopts it, creating it only if absent
  — an `Fn::ImportValue` there would make the per-app stack un-deployable in any
  account whose provider we did not create.
- **`us-east-1` appears for exactly three things** (ADR-0017): the ACM
  certificate, the Lambda@Edge function, and the CUR definition. Anything else
  there needs justification.

## Adding to a stack's `config.yml`

Non-sensitive, shared or per-environment → `config.yml`, threaded through the
root `locals` to the module input. **Never let a module read the file** — a
module that knows about `config.yml` cannot be reused by a second stack.

Secrets never go here. They are generated in `identity`, or arrive as a shell
parameter seeded out of band.

## Bootstrap ordering, and the one way to get it wrong

`make entra` and `make google-oauth` **must run after** the `identity` stack has
applied for an environment, not before.

The identity stack creates `/fit/{env}/auth/{idp}/client_secret` as a shell
holding `UNSEEDED` and then ignores changes to its value; the seeding scripts
overwrite that value and nothing else. Run in the other order, the script
creates the parameter and the identity stack's next apply dies with
`ParameterAlreadyExists` — permanently, because Terraform will not adopt a
resource it did not create. Recovering means a state import or deleting the
parameter.

Both scripts now refuse to create a parameter and name the fix instead. The
correct sequence for a fresh environment is:

```sh
make bootstrap                 # once per account/app
make github-environments       # once per repo
make cold-start ENV=dev        # identity -> data -> api -> edge -> archive -> frontend
make entra                     # AFTER identity exists; re-run seeds all three envs
make google-oauth              # ditto, from reference/gcloud-oauth.txt
```

An environment whose Google secret is still `UNSEEDED` is not broken — the edge
derives which providers to offer from what is seeded, so it shows Entra alone
and skips the chooser (ADR-0035). A missing seed is a **hidden provider**, never
a button that fails at the token exchange.
- **An Athena workgroup cannot be deleted while it holds query history.** The
  removal in ADR-0025 planned cleanly and then failed at apply with
  `InvalidRequestException: WorkGroup fit-finops is not empty` — 84 past query
  executions count as contents. `force_destroy = true` would have covered it,
  but by then the resource was already out of the configuration and Terraform
  could only try the plain delete. The fix was an out-of-band
  `aws athena delete-work-group --recursive-delete-option`, after which the
  apply reconciled. **Put `force_destroy` on a resource BEFORE the commit that
  removes it**, or accept a manual step.
- **`aws_bcmdataexports_export` gains `BILLING_VIEW_ARN` on its own.** AWS
  returns a table-configuration key the configuration never set, and the
  provider rejects the mismatch with "Provider produced inconsistent result
  after apply". It is declared explicitly, derived from the account id
  (`arn:aws:billing::{account}:billingview/primary`), so planned and applied
  agree.
- **A new SSM parameter breaks the tag deploy's `api` plan, once.** Per-stack
  workflows run in PARALLEL on a tag, so when `api` starts reading a parameter
  that `data` has only just begun creating, `plan / prod` fails with
  `reading SSM Parameter (…): couldn't find resource`. It is the cold-start
  ordering problem (ADR-0022) arriving on an established environment rather than
  an empty one. The fix is the same both times: let `data` finish, then re-run
  the `api` workflow. Adding a cross-stack parameter is therefore a **two-pass
  deploy**, and worth saying so in the tag message.
