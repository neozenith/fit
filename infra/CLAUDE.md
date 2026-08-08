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
entra/         The OAuth app registration. Different cloud, different identity.
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

`make entra` **must run after** the `identity` stack has applied for an
environment, not before.

The identity stack creates `/fit/{env}/auth/entra/client_secret` as a shell
holding `UNSEEDED` and then ignores changes to its value; `entra_app.sh`
overwrites that value and nothing else. Run in the other order, the script
creates the parameter and the identity stack's next apply dies with
`ParameterAlreadyExists` — permanently, because Terraform will not adopt a
resource it did not create. Recovering means a state import or deleting the
parameter.

The script now refuses to create a parameter and names the fix instead. The
correct sequence for a fresh environment is:

```sh
make bootstrap                 # once per account/app
make github-environments       # once per repo
make cold-start ENV=dev        # identity -> data -> api -> edge -> archive -> frontend
make entra                     # AFTER identity exists; re-run seeds all three envs
```
