# Architecture Decision Records

Every entry states the decision, the forces behind it, and — critically — the
**Lens** it projects forward. The Lens is the reusable rule: when a later
question falls inside a Lens, the answer is already made and does not become an
open question. Check this file before adding anything to
[`docs/questions/`](docs/questions/).

Status values: `Accepted`, `Superseded by ADR-NNNN`, `Proposed`.

| ADR | Decision | Status |
|---|---|---|
| [0001](#adr-0001--the-program-is-a-pure-function-not-stored-rows) | The program is a pure function, not stored rows | Accepted |
| [0002](#adr-0002--one-aws-account-three-environments-separated-by-name-and-tag) | One AWS account, three environments separated by name and tag | Accepted |
| [0003](#adr-0003--scale-to-zero-means-lambda--dynamodb-not-a-parked-container) | Scale-to-zero means Lambda + DynamoDB, not a parked container | Accepted |
| [0004](#adr-0004--cloudformation-is-the-trust-floor-below-terraform) | CloudFormation is the trust floor below Terraform | Accepted |
| [0005](#adr-0005--terraform-state-is-one-bucket-keyed-by-stack-and-environment) | Terraform state is one bucket, keyed by stack and environment | Accepted |
| [0006](#adr-0006--ci-is-the-only-actor-that-runs-terraform) | CI is the only actor that runs Terraform | Accepted |
| [0007](#adr-0007--git-event-selects-the-environment-draft--plan-pr--dev-main--test-tag--prod) | Git event selects the environment | Accepted |
| [0008](#adr-0008--stacks-are-sized-by-blast-radius-and-change-cadence) | Stacks are sized by blast radius and change cadence | Accepted |
| [0009](#adr-0009--authentication-terminates-at-lambdaedge-never-in-the-application) | Authentication terminates at Lambda@Edge, never in the application | Accepted |
| [0010](#adr-0010--entraid-is-the-only-identity-provider) | EntraID is the only identity provider | Accepted |
| [0011](#adr-0011--the-session-hmac-key-is-the-agentic-test-key) | The session HMAC key is the agentic test key | Accepted |
| [0012](#adr-0012--hot-data-lives-in-dynamodb-cold-data-becomes-parquet-on-s3) | Hot data lives in DynamoDB, cold data becomes Parquet on S3 | Accepted |
| [0013](#adr-0013--observations-are-append-only-and-never-rewritten-by-the-program) | Observations are append-only and never rewritten by the program | Accepted |
| [0014](#adr-0014--every-resource-carries-project-and-environment-cost-allocation-tags) | Every resource carries Project and Environment cost-allocation tags | Accepted |
| [0015](#adr-0015--finops-is-one-environment-agnostic-stack-readable-from-every-environment) | FinOps is one environment-agnostic stack, readable from every environment | Accepted |
| [0016](#adr-0016--local-development-runs-the-real-handlers-against-emulated-aws) | Local development runs the real handlers against emulated AWS | Accepted |
| [0017](#adr-0017--sydney-for-data-us-east-1-only-where-aws-forces-it) | Sydney for data, us-east-1 only where AWS forces it | Accepted |
| [0018](#adr-0018--single-tenant-single-user-by-construction) | Single-tenant, single-user by construction | Accepted |
| [0019](#adr-0019--typescript-everywhere-in-the-request-path-python-only-for-analytics) | TypeScript everywhere in the request path, Python only for analytics | Accepted |
| [0020](#adr-0020--questions-are-queued-never-blocking) | Questions are queued, never blocking | Accepted |
| [0021](#adr-0021--a-literal-weight-nudge-in-the-source-workbook-means-one-increment) | A literal weight nudge in the source workbook means one increment | Accepted |
| [0022](#adr-0022--a-cold-environment-is-stood-up-by-one-ordered-ci-run-not-by-relaxing-the-stacks) | A cold environment is stood up by one ordered CI run | Accepted |
| [0023](#adr-0023--ci-concurrency-is-keyed-on-the-terraform-state-key-not-the-git-ref) | CI concurrency is keyed on the Terraform state key | Accepted |
| [0024](#adr-0024--the-spa-fallback-lives-in-the-edge-function-not-in-custom_error_response) | The SPA fallback lives in the edge function | Accepted |
| [0025](#adr-0025--duckdb-in-the-lambda-replaces-glue-and-athena) | DuckDB in the Lambda replaces Glue and Athena | Accepted |

---

## ADR-0001 — The program is a pure function, not stored rows

**Status:** Accepted

**Context.** The source spreadsheet computes every prescribed weight from three
`Inputs!` cells (`B14` bench, `B15` squat, `B16` deadlift 1RMs), a units flag,
and a start date. A Week 3 squat cell is literally
`MROUND(1RM_squat * 0.85, 2.5) + 2.5`. Not one prescribed weight is typed by
hand; all 6 weeks are a projection of the block's seed.

The naive port stores the computed grid — 6 weeks × ~5 sessions × ~7 exercises
of denormalised weights. That representation is wrong the moment a 1RM is
corrected (the spreadsheet's own rule: *"if you ever fail a required rep, reduce
your max by 2.5%"*), because every downstream row silently goes stale.

**Decision.** The program is a **pure generator**: `(BlockConfig) → Session[]`.
Nothing prescribed is persisted. DynamoDB stores only the *inputs* (block
config: seed 1RMs, units, start date, accessory choices) and the *outputs*
(observations: what was actually lifted). The prescription is recomputed on
every read.

**Consequences.** Correcting a 1RM is a single-item write that re-projects the
whole block. The engine is a dependency-free module testable without any AWS
surface, and the spreadsheet's own values become golden-test fixtures.

> **Lens.** If a value can be derived from stored inputs, derive it. Persist
> inputs and observations; never persist a projection. When asked "where do we
> store X?", first ask whether X is a projection.

---

## ADR-0002 — One AWS account, three environments separated by name and tag

**Status:** Accepted

**Context.** `fit` is a single-user personal application. A multi-account
landing zone would triple the bootstrap surface and the DNS delegation work for
no isolation benefit that a naming convention does not already give at this
scale.

**Decision.** All three environments live in account `947404949660`. Isolation
is by resource-name prefix (`fit-{env}-*`), IAM path, DynamoDB table name, SSM
parameter prefix (`/fit/{env}/`), and the `Environment` tag. The `jpeak.ai`
hosted zone already lives in this account, so DNS is direct record creation.

**Consequences.** A stack must never reference a resource without its `{env}`
segment. Cross-environment blast radius is prevented by naming discipline, not
by an account boundary — which is exactly why ADR-0014's tagging is mandatory
rather than nice-to-have, and why the FinOps stack can see all three
environments at once (ADR-0015).

> **Lens.** Environment is a *string in a name*, not an account. Any new
> resource is named `fit-{env}-<thing>` and any new parameter lives under
> `/fit/{env}/`. No question about "which account" is open.

---

## ADR-0003 — Scale-to-zero means Lambda + DynamoDB, not a parked container

**Status:** Accepted

**Context.** The container-based prior art achieved scale-to-zero by parking an
ECS service at `desired_count = 0` and adding an origin-request Lambda@Edge hook
that woke the service and returned a `202 Warming` page while it started. That
machinery — the wake hook, the parked CNAME that must stay resolvable, the
`min_ttl = 0` on 502/504 so a cached error cannot bypass the hook — exists
purely to hide container start latency.

A fitness tracker serves a handful of requests a day to one user. The workload
has no warm-path requirement that justifies any of it.

**Decision.** The request path is CloudFront → S3 (SPA) and CloudFront → Lambda
Function URL (API), with DynamoDB on-demand behind it. There is no VPC, no NAT
gateway, no ECS, no ALB, and no wake hook. Idle cost is the hosted zone, the
CloudFront distribution, and stored bytes.

**Consequences.** Cold start is a Lambda cold start (~200ms for a Bun/Node
handler), not a container start — cheap enough to need no warming UX. Removing
the VPC removes the single largest fixed cost in the prior architecture. The
`202 Warming` page, the parked CNAME gotcha, and the error-TTL interlock are all
*deliberately absent*; do not port them.

> **Lens.** Prefer the managed primitive that bills at zero when idle. Any
> proposal that adds an always-on component (NAT, ALB, RDS, a warm pool) needs
> an ADR of its own that names what breaks without it.

---

## ADR-0004 — CloudFormation is the trust floor below Terraform

**Status:** Accepted

**Context.** Terraform needs a state bucket to write state into, and a role to
assume before it can create either. That circularity has to be broken outside
Terraform.

**Decision.** Two idempotent CloudFormation stacks, run by a human from a
laptop, create everything Terraform depends on and nothing else:

1. `github-oidc-baseline` — the account-singleton GitHub OIDC provider. One per
   *account*, because IAM permits only one provider per issuer URL, so it can
   never live in a per-app stack.
2. `fit-bootstrap` — the state bucket and the repo-scoped deployer role, which
   imports the provider ARN via `Fn::ImportValue`.

Both the bucket and the zone carry `DeletionPolicy: Retain`.

**Consequences.** `terraform destroy` — or deleting the bootstrap stack itself —
cannot destroy the state that describes the platform. The bootstrap is the one
layer a human runs; everything above it is CI-only (ADR-0006).

> **Lens.** If Terraform would need a resource in order to create that same
> resource, it belongs in the CloudFormation bootstrap. Nothing else does.

---

## ADR-0005 — Terraform state is one bucket, keyed by stack and environment

**Status:** Accepted

**Context.** Six stacks × three environments is eighteen state files. A bucket
per combination is eighteen bootstrap resources to manage.

**Decision.** One bucket, `fit-tfstate-947404949660`, versioned and encrypted,
with keys of the form `{stack}/{env}.tfstate`. Locking is S3-native
(`use_lockfile = true`) — there is no DynamoDB lock table. Backends are
**partial**: each stack ships `backends/{env}.config` and CI passes it to
`terraform init -backend-config=`.

**Consequences.** A stack's blast radius is exactly its own key. Two stacks
deploy concurrently without contending for a lock; two environments of the same
stack also do not contend. Because the backend is partial, any local `terraform`
command inherits whichever environment was last initialised — which is a hazard,
and one more reason for ADR-0006.

> **Lens.** New stack ⇒ new `backends/*.config` per environment, same bucket,
> key `{stack}/{env}.tfstate`. No question about state layout is open.

---

## ADR-0006 — CI is the only actor that runs Terraform

**Status:** Accepted

**Context.** Partial backends (ADR-0005) mean a local `terraform apply` silently
targets the last-initialised environment. Local state drift is invisible to the
plan a reviewer reads on a pull request.

**Decision.** No `terraform apply` or `terraform plan` against real state
happens outside GitHub Actions. The local surface is `make tf-check`:
`fmt -check` plus `init -backend=false` plus `validate`. It touches no cloud and
no state.

**Consequences.** The plan posted on the pull request is the only plan, and it
is therefore trustworthy. An agent (including this one) verifies infrastructure
changes by reading CI output, not by applying locally.

> **Lens.** "Just apply it locally to check" is never the answer. Push, and read
> the plan.

---

## ADR-0007 — Git event selects the environment (draft → plan, PR → dev, main → test, tag → prod)

**Status:** Accepted

**Context.** Promotion needs to be mechanical and unambiguous, and the mapping
must be visible without reading workflow YAML.

**Decision.** One reusable workflow owns the routing; per-stack callers only
pass their stack name and path filters.

| Git event | Result |
|---|---|
| Draft pull request | `ci` + `plan` matrix across dev/test/prod. No apply. |
| Ready-for-review pull request | `ci` + `plan` + `apply / dev` |
| Push to `main` | `ci` + `plan` + `apply / test` |
| Push of a `v*` tag | `ci` + `plan` + `apply / prod` |

`plan` runs on **every** trigger across **all three** environments, and every
apply `needs: [ci, plan]`. `plan` deliberately binds no GitHub Environment —
prod is gated to `v*` tags, so a `plan / prod` job on a PR branch would be
rejected by its own gate. Plans take the deployer role from the repo-level
variable instead; only applies bind `environment:`.

**Consequences.** A draft PR is a genuine, zero-risk "what would this do
everywhere" report. Marking a PR ready for review is the act that first mutates
cloud state, and it mutates dev only.

> **Lens.** Promotion is a Git event, never a workflow input. Adding a manual
> `workflow_dispatch` path to any environment other than prod needs its own ADR.

---

## ADR-0008 — Stacks are sized by blast radius and change cadence

**Status:** Accepted

**Context.** A single stack means every frontend tweak re-plans the database and
the certificate. Too many stacks means cross-stack data-passing complexity.

**Decision.** Six stacks. Five are per-environment; one is global.

| Stack | Owns | Changes when |
|---|---|---|
| `identity` | SSM shells for IdP credentials, generated session HMAC key | IdP config changes (rare) |
| `data` | DynamoDB tables, archive bucket, Glue database | schema changes (rare) |
| `api` | API Lambda, its role, its Function URL | app code changes (often) |
| `edge` | ACM cert, CloudFront, auth Lambda@Edge, DNS record, SPA bucket | routing/auth changes (rare, slow) |
| `archive` | age-out Lambda, its schedule | retention policy changes (rare) |
| `finops` | CUR export, Glue, Athena workgroup | global; merge to `main` only |

Cross-stack reads go through SSM parameters under `/fit/{env}/`, never through
`terraform_remote_state` — the reader must not need the writer's state file or
its backend credentials.

**Consequences.** A CloudFront change (15+ minutes to propagate) never blocks an
API deploy (seconds). Stacks are also the unit of path filtering in CI, so an
`api` change does not queue behind an `edge` plan.

> **Lens.** New infrastructure joins the stack whose *cadence* it matches, not
> the stack whose *diagram box* it sits nearest. If it changes on a different
> rhythm than everything in the candidate stack, it is a new stack.

---

## ADR-0009 — Authentication terminates at Lambda@Edge, never in the application

**Status:** Accepted

**Context.** An application that checks its own authentication can be reached
un-authenticated by anything that bypasses the front door — a Function URL
called directly, an S3 object fetched by its bucket URL.

**Decision.** A viewer-request Lambda@Edge function is the sole authenticator.
It:

1. **Strips every inbound `x-auth-*` header first**, before any other logic. A
   header the function sets but forgets to strip is free privilege escalation,
   because CloudFront forwards viewer headers to the origin verbatim.
2. Rejects any non-canonical `Host` with **421**, never 403 — a 403 would be
   laundered into the app by the SPA error rewrite.
3. Handles `/oauth2/*` entirely at the edge; the origin never sees those paths.
4. On a valid `__session` cookie, injects `x-auth-email`, `x-auth-exp` (300s
   TTL) and `x-auth-sig = HMAC(email.exp)`.

The origin verifies the signature and trusts nothing else. The Function URL uses
`AWS_IAM` auth with an origin-access control, so it is unreachable without
CloudFront's signature.

**Consequences.** The application has no login code, no session store, and no
IdP dependency. Its entire auth surface is "verify one HMAC".

> **Lens.** Identity is asserted at the edge and verified at the origin. Any
> proposal to add an auth check *inside* the app is a proposal to add a second
> source of truth — reject it.

---

## ADR-0010 — EntraID is the only identity provider

**Status:** Accepted

**Context.** The prior art supports a pluggable provider map with a chooser page
for multiple IdPs. The operator here has exactly one tenant
(`89e9e78f-7730-4825-b42f-fb0986fe3088`) and is the only user (ADR-0018).

**Decision.** EntraID only, via OIDC authorization-code flow with PKCE.
Admission is `claims.tid == entra_tenant_id` **and** the email appearing in an
explicit allow-list. The chooser page is not built — with one provider the edge
redirects straight to the authorize URL.

The provider surface is still isolated in a `PROFILES` map so that adding a
second IdP is one map entry plus its SSM shells, not a refactor.

**Consequences.** No chooser UI, no home-realm discovery, no per-provider
branching in the callback — the token is verified against exactly one JWKS,
issuer and audience.

> **Lens.** One provider, allow-listed by tenant *and* email. Both checks, or
> the tenant check alone admits every account in the tenant.

---

## ADR-0011 — The session HMAC key is the agentic test key

**Status:** Accepted

**Context.** Verifying a deployed environment end-to-end requires an
authenticated session. Driving an interactive EntraID sign-in from a headless
agent is fragile, and stashing a long-lived bearer token anywhere is worse.

**Decision.** The `identity` stack generates one HMAC key per environment into
`/fit/{env}/session_hmac_key` (SecureString). That key signs the `__session`
cookie, `x-auth-sig`, and nothing else. A CLI (`make token ENV=dev`) reads the
parameter with the caller's own AWS credentials and mints a short-lived session
cookie locally.

Minted sessions carry a **10 minute** expiry — long enough for a Playwright run,
short enough that a leaked cookie is worthless — and an `x-auth-actor: agent`
claim so the audit trail distinguishes them from human sign-ins.

**Consequences.** Access to a test session is exactly access to the SSM
parameter, which is already governed by IAM. Revocation is a key rotation, which
invalidates every human session too — acceptable, because re-authenticating is
one redirect.

> **Lens.** Test credentials are *derived from* IAM-governed material at use
> time, never stored. If a testing path needs a secret checked in anywhere, the
> design is wrong.

---

## ADR-0012 — Hot data lives in DynamoDB, cold data becomes Parquet on S3

**Status:** Accepted

**Context.** Observations accumulate forever, but only the current block and a
trailing window are ever read interactively. Charts over years of history are
analytical scans, which is the one access pattern DynamoDB prices worst.

**Decision.** DynamoDB holds a rolling **13-month** hot window. A scheduled
age-out Lambda writes older items to
`s3://fit-{env}-archive/{table}/year=YYYY/month=MM/*.parquet`, registers them in
Glue, and only then deletes the DynamoDB items. The API reads DynamoDB for the
hot window and Athena for anything older, transparently.

13 months, not 12: it guarantees a full year-on-year comparison is always
answerable from the hot path alone.

**Consequences.** Delete-after-verify ordering means the failure mode is
duplicate data (recoverable, dedup on read by sort key) rather than data loss.
Config tables are never aged out — they are small and always hot.

> **Lens.** Age-out is copy → verify → delete, in that order, always. Any table
> holding time-series observations gets an age-out path; any table holding
> configuration does not.

---

## ADR-0013 — Observations are append-only and never rewritten by the program

**Status:** Accepted

**Context.** The block-to-block recursion (Week 6 projected max seeds the next
block's 1RMs) is tempting to implement as an in-place update of the athlete's
current 1RM.

**Decision.** A new block is a **new item** with its own `blockId` and its own
seed 1RMs, carrying `derivedFrom` pointing at the previous block. Logged sets
are immutable once written; a correction is a new item that supersedes by
timestamp, not an overwrite.

**Consequences.** The whole training history is reconstructible, and "what did I
believe my max was in March" is answerable. The Week 6 projection
(`week5_weight × 1.03 / 1.06 / 1.09` for 2 / 3 / 4 reps) is recorded as a
*proposal* the user accepts, so an unaccepted projection never silently changes
next block's prescription.

> **Lens.** Never `UpdateItem` a fact about the past. New facts are new items.

---

## ADR-0014 — Every resource carries Project and Environment cost-allocation tags

**Status:** Accepted

**Context.** With three environments in one account (ADR-0002), the tag is the
*only* thing that attributes a dollar to an environment. An untagged resource is
permanently unattributable — Cost Explorer cannot retroactively tag history.

**Decision.** Every Terraform provider carries `default_tags` with `Project =
"fit"`, `Environment = <env>`, `ManagedBy = "terraform"`, and `Stack = <stack>`.
Both `Project` and `Environment` are activated as cost-allocation tags. The
CloudFormation bootstrap tags its own stacks equivalently with `ManagedBy =
"bootstrap"`.

Resources that AWS does not propagate `default_tags` to (CloudFront's edge
replicas, some Lambda@Edge artefacts) are tagged explicitly at the resource.

**Consequences.** The FinOps stack (ADR-0015) can group by environment without
any account boundary. Tag activation is retroactive-blind, so it is part of
bootstrap and must happen before the first spend.

> **Lens.** A resource without `Project` and `Environment` is a bug, not a
> style issue. Adding a provider block means adding `default_tags`.

---

## ADR-0015 — FinOps is one environment-agnostic stack, readable from every environment

**Status:** Accepted

**Context.** Cost data is account-scoped: one Cost and Usage Report covers all
three environments. Deploying a copy per environment would create three CUR
exports of the same data and triple the storage.

**Decision.** `finops` is a single global stack — one CUR 2.0 export, one S3
bucket, one Glue database, one Athena workgroup. It deploys on **merge to
`main`** only (not on tags, not on PRs), because it has no environment to
promote through.

Every environment's API is granted read access to the same Athena workgroup and
results prefix, so the FinOps page renders identical data from dev, test or
prod, filterable by the `Environment` tag.

**Consequences.** A FinOps change is verified in `test` and is simultaneously
live in prod — accepted deliberately, because the stack is read-only reporting
over data it does not own. The FinOps *page* still ships through the normal
promotion path, since it is application code.

> **Lens.** Data that is account-scoped gets one stack, not one per environment.
> Its consumers get read grants, not copies.

---

## ADR-0016 — Local development runs the real handlers against emulated AWS

**Status:** Accepted

**Context.** A local mode that stubs the API is a second implementation that
drifts. The point of a local loop is to catch bugs that would otherwise only
appear in dev.

**Decision.** `make dev` starts DynamoDB Local in Docker, seeds the tables with
the same Terraform-described schema, and runs the **same** handler modules the
Lambda entry point wraps — behind a thin local HTTP server rather than a
Function URL. The SPA runs on Vite with a proxy to it.

Auth locally is the same HMAC verification as production; `make token ENV=local`
mints against a fixed development key. There is no `if (isLocal) skipAuth`
branch anywhere in the request path.

**Consequences.** The only untested-locally surfaces are CloudFront behaviours
and the Lambda@Edge function itself, which is why the edge auth module carries
its own unit tests and the e2e suite runs against deployed environments too.

> **Lens.** Local differs from deployed in *transport and backing store only*.
> A conditional that changes business or auth logic based on environment is a
> defect.

---

## ADR-0017 — Sydney for data, us-east-1 only where AWS forces it

**Status:** Accepted

**Decision.** `ap-southeast-2` for everything with a choice. `us-east-1` for
exactly three things AWS gives no choice about: the ACM certificate that
CloudFront consumes, the Lambda@Edge function, and the Cost and Usage Report
definition.

**Consequences.** Stacks that touch the edge declare a second aliased provider
`aws.us_east_1`. Lambda@Edge has no environment variables, so its configuration
is **synthesized into the deployment bundle** as `config.json` at plan time —
that file does not exist on disk, and looking for it in the source tree is a
known dead end.

> **Lens.** `us-east-1` appears only for cert, edge function, and CUR. Any other
> us-east-1 resource needs justification.

---

## ADR-0018 — Single-tenant, single-user by construction

**Status:** Accepted

**Context.** Building multi-user tenancy speculatively costs a partition-key
design, an authorization layer, and per-user data isolation tests for a user
base of one.

**Decision.** The data model is keyed by `userId` from day one — the partition
key is `USER#{email}` — but there is exactly one admitted email, enforced at the
edge (ADR-0010). No sharing, no roles, no invitations, no per-user settings UI.

**Consequences.** Multi-user is a later *policy* change (widen the allow-list)
plus an authorization layer, not a data migration. The key design does not have
to be revisited.

> **Lens.** Key by user, admit one user. Do not build sharing, roles, or
> invitations until a second real user exists.

---

## ADR-0019 — TypeScript everywhere in the request path, Python only for analytics

**Status:** Accepted

**Context.** The program engine (ADR-0001) must run identically in the browser
(instant re-projection as a 1RM is edited) and on the server (authoritative
prescription). Two implementations of `MROUND` rounding would drift, and the
drift would be silent — a 2.5kg discrepancy looks like a typo, not a bug.

**Decision.** One TypeScript package, `packages/program`, imported by both the
SPA and the API handler. Bun is the runtime and package manager. Python appears
only where it is genuinely better and never in the request path: the Parquet
age-out job (ADR-0012) and analysis helpers.

**Consequences.** The engine's golden tests run once and cover both consumers.
The archive Lambda is the sole Python runtime in the platform.

> **Lens.** If browser and server must agree on a computation, there is exactly
> one implementation of it, in TypeScript, in `packages/program`.

---

## ADR-0020 — Questions are queued, never blocking

**Status:** Accepted

**Context.** A first version of a personal application stalls on clarification
round-trips far more often than it fails on a wrong assumption — and a wrong
assumption in a single-user app is cheap to reverse.

**Decision.** An ambiguity is resolved by (1) checking the Lenses above, and
only if no Lens covers it, (2) recording it as
`docs/questions/Q{NN}-{stub}.md`, stating the assumption taken, and continuing.
Each question file carries the decision made in the interim, so the queue is a
list of *reversible commitments*, not a list of blockers.

**Consequences.** Every question in the queue is answerable later without
rework, or the assumption would have been a blocker instead.

> **Lens.** Never stop to ask. Decide, record the assumption, continue.

---

## ADR-0021 — A literal weight nudge in the source workbook means one increment

**Status:** Accepted — confirmed by the athlete, 2026-08-08
([Q01](docs/questions/Q01-spreadsheet-formula-deviations.md))

**Context.** The source workbook writes every adjustment on top of a percentage
as a literal number: `+2.5` here, `-5` there. Some of those literals appear
inside both branches of the kilogram/pound conditional, which makes them right
in one unit system and wrong in the other. Week 4's bench subtracts a literal
`5` in the kilogram branch — two increments, a 12.5% drop on a 40kg bench.

The question was whether to reproduce the workbook faithfully (preserving
continuity with training already logged against it) or implement the evident
intent.

**Decision.** Every literal nudge in the workbook means **one increment** in the
athlete's own units — 2.5kg or 5lb. The engine expresses nudges as a *count of
increments* rather than a weight, so the intent is unit-independent by
construction and the class of bug cannot recur.

A second workbook defect is covered by the same reading: Week 1 Day 4 tests
`Inputs!B36`, an empty cell, instead of the units flag at `B11`. It reads the
flag, like every other formula does.

**Consequences.** The engine and the workbook disagree on exactly two cells,
and the golden tests mark both `DEVIATION` with the reasoning inline — the
markers stay so a future reader diffing against the workbook is not confused by
the mismatch.

> **Lens.** A literal `+2.5` or `-5` in the workbook is *one increment*, never a
> weight. Any further formula ported from the workbook applies that reading
> without re-asking. A conditional in the workbook that references an empty cell
> is a copy/paste slip — find the cell it meant.

---

## ADR-0022 — A cold environment is stood up by one ordered CI run, not by relaxing the stacks

**Status:** Accepted — forced by the first real pipeline run, 2026-08-08

**Context.** Stacks pass identifiers through SSM (ADR-0008), so a downstream
stack cannot even *plan* until its upstream has *applied* — the parameter it
reads does not exist yet. On a warm environment this is invisible. On a brand
new one, `api` and `edge` fail their plan with "couldn't find resource", which
looks like a broken pipeline and is actually an empty account.

Two obvious fixes were both worse:

- **Let a stack tolerate a missing upstream behind a flag.** That puts a
  conditional inside the plan, so what CI shows a reviewer is no longer what
  will be applied — which destroys the property ADR-0006 exists to protect.
- **Apply by hand from a laptop, once.** That breaks ADR-0006 outright, and
  with a partial backend "by hand" silently targets whichever environment was
  last initialised.

**Decision.** A `workflow_dispatch`-only **cold-start workflow** applies one
environment's stacks in dependency order: `identity → data → api → edge →
archive → frontend → activate tags`. One job per stack, chained with `needs`,
so the chain *is* the dependency graph — a reader sees the order in the run
summary, and a failure stops everything downstream automatically.

It is manual-trigger only. No Git event should ever apply a whole environment.

**Consequences.** The steady-state pipeline stays simple: each stack plans and
applies independently on its own path filter, with no ordering logic anywhere.
The ordering exists in exactly one place, is used approximately once per
environment, and is readable.

The tag-activation second pass lives at the end of this workflow rather than in
the bootstrap, because a tag key is only activatable after AWS has observed it
on a real resource — and until the first apply there are none.

> **Lens.** Cold-start ordering is a *workflow* concern, never a *stack*
> concern. If a stack needs to know whether its upstream exists, the ordering
> has leaked into the wrong layer.

---

## ADR-0023 — CI concurrency is keyed on the Terraform state key, not the Git ref

**Status:** Accepted — forced by a real collision, 2026-08-08

**Context.** The first version keyed the reusable workflow's concurrency group
on `tf-{stack}-{github.ref}`. That reads sensibly and is wrong, in a way that
appears only under load.

A merge to `main` triggers `apply / test`. The cold-start workflow, dispatched
separately, also applies `identity` for `test`. Different workflows, different
refs — so no shared group — and both applied `identity/test.tfstate` at the same
moment. One failed with `Saved plan is stale`.

That failure is the atomic plan-then-apply guarantee (ADR-A1) working exactly as
designed: the applied plan must be the reviewed plan, and it refused a plan the
world had moved out from under. But it fired *after* both jobs had already
contended for the S3 lock, which is late and confusing.

**Decision.** Concurrency is keyed on the thing that is actually contended: the
**state key**. Any job that applies `{stack}/{env}` uses the group
`tfstate-{stack}-{env}`, in whichever workflow it lives.

The workflow-level group is removed entirely. Plans are read-only and must never
queue behind each other — serialising them only made the pipeline slow without
making it safer.

**Consequences.** Two workflows that touch the same state now serialise before
they authenticate, rather than racing and losing at the plan-staleness check.
Plans of different environments run fully in parallel. A new workflow that
applies Terraform must adopt the same group name — it is the shared vocabulary,
not a per-workflow choice.

> **Lens.** Key a concurrency group on the *resource being mutated*, never on
> the *event that triggered the mutation*. If two triggers can reach the same
> state, keying on the trigger guarantees they will eventually collide.

---

## ADR-0024 — The SPA fallback lives in the edge function, not in `custom_error_response`

**Status:** Accepted — forced by a real failure, 2026-08-08

**Context.** A single-page application needs deep links to serve `index.html`
rather than 404. The obvious CloudFront mechanism is `custom_error_response`,
mapping 403 and 404 to `/index.html` with status 200.

It is a trap, and the reason is a detail of the CloudFront model:
`custom_error_response` is a property of the **distribution**, not of a cache
behaviour. CloudFront offers no per-behaviour form. So a rule intended for the
S3 origin also catches responses from the API origin.

The consequence was found by a tool, not by reading: `POST /api/blocks` returned
**HTTP 200 with an HTML body**. The origin had refused the request with 403, and
the distribution had rewritten it into the application's own index page. A
refused write looked like a successful one; the only symptom was a JSON parse
error in the client, several layers away from the cause.

That is precisely the laundering ADR-0009 forbids for the 421 host check — and
it had been reintroduced through a different door, while the documentation
asserted (wrongly) that the rule was "scoped to the S3 origin only".

**Decision.** No `custom_error_response` on the distribution at all. The edge
authenticator rewrites `request.uri` to `/index.html` at viewer-request, and
only for a path that is actually a SPA route: no file extension, and not under
`/api/`.

**Consequences.** Every origin error keeps its own status and body, so a 403 is
a 403 and a 502 is a 502. The fallback is scoped by an explicit predicate that
is unit-tested, rather than by a status code that several origins share.

An asset request is deliberately *not* rewritten: serving `index.html` for a
missing `.js` produces a syntax error in the console instead of a 404, which is
among the most time-consuming ways for a missing file to present.

> **Lens.** Before using a platform feature to shape one origin's responses,
> check its SCOPE. A distribution-wide rule applied to fix one behaviour will
> silently reshape every other one — and the damage shows up furthest from the
> configuration that caused it.

---

## ADR-0025 — DuckDB in the Lambda replaces Glue and Athena

**Status:** Accepted — supersedes the query surface of ADR-0012 and ADR-0015

**Context.** The first design catalogued Parquet with Glue and queried it with
Athena, because that is the default answer to "Parquet on S3". Building it
exposed how poorly that answer fits *this* workload.

**Athena is priced and shaped for data this platform does not have.** It bills a
**10MB minimum per query**. One user's training log is a few thousand rows a
year — kilobytes. Every query would be billed at ~200× the bytes it read. Even
the CUR is tens of megabytes a month.

**The catalogue is a second source of truth that must be kept in sync.** A Glue
crawler runs on a schedule, so freshly archived data is invisible until it next
runs — the FinOps page reported "no data yet" for hours after a successful
deploy, and that was correct behaviour. The crawler also needs
`CombineCompatibleSchemas`, because a CUR gains columns whenever AWS adds a
service, and without it the crawler silently creates a *new table* and the old
one stops updating.

**Athena is asynchronous, so the client is a polling loop.** Start, poll, fetch,
with a timeout ceiling and a free-text failure string that has to be pattern
matched to tell "the table does not exist yet" from "you lack permission" — an
entire module (`finops-errors.ts`) existing only to classify one vendor's error
prose, with tests pinning a regex against strings AWS may reword.

**Decision.** Delete Glue and Athena entirely. Query the Parquet in S3 directly
with **DuckDB, inside the Lambda**:

```sql
SELECT ... FROM read_parquet('s3://bucket/tables/sets/**/*.parquet',
                             hive_partitioning = true)
```

The S3 layout **is** the schema. There is no catalogue to register, crawl, or
drift.

**Consequences — mostly deletion:**

| Removed | |
|---|---|
| Glue database ×2, crawler, crawler IAM role | ~10 Terraform resources |
| Athena workgroups ×2, results prefix + lifecycle rule | |
| `glue:` and `athena:` IAM statements | 8 |
| Athena start/poll/fetch client | ~160 lines |
| `finops-errors.ts` and its regex tests | 28 lines + 15 tests |
| `register_partition` in the archive job | and its swallowed-error path |

That last one is a genuine correctness gain, not just less code: partition
registration was the **only** place in the age-out job where an error was logged
and continued. With no catalogue there is nothing to register, so the exception
disappears rather than being justified.

Newly archived data is queryable **immediately**, because writing the file *is*
publishing it.

**What it costs.** A 36MB Lambda layer and a build script, which turned out to
carry three traps rather than the one anticipated:

1. **`npm`/`bun` resolve the native binding for the build host.** A layer built
   on macOS ships the darwin binary. The binding is an *optional dependency*
   keyed on `os`/`cpu`, so the fix is `npm --os=linux --cpu=arm64 --libc=glibc`
   — and `--include=optional`, without which npm resolves nothing for either
   platform, exits 0, and produces a layer with no binary in it.
2. **Only `parquet` is statically linked.** `httpfs` and `aws` are downloaded on
   first use into `$HOME`, which Lambda mounts read-only — so the first S3 read
   fails in the deployed environment and nowhere else. Both are baked into the
   layer and autoinstall is disabled, so a missing bake fails loudly.
3. **An empty glob is an error, not an empty result.** The claim above that "a
   missing prefix returns zero rows" was wrong: `read_parquet` raises
   `IO Error: No files found`. The API decides that case from a `glob()`
   listing, which genuinely does return zero rows. Deciding it from the error
   *text* would have reinstated the classifier this ADR set out to delete.

> **Lens.** Match the query engine to the data's SIZE, not to its FORMAT.
> "Parquet on S3" suggests a warehouse; kilobytes suggest a library. A managed
> service that bills a minimum per query is the wrong shape for data smaller
> than that minimum, however well it fits the file format.

## ADR-0026 — Imported history is a separate, read-only archive, not backfilled into DynamoDB

**Status:** Accepted — settles [Q02](docs/questions/Q02-cold-read-path-is-not-wired-up.md)

**Context.** Five years of training predate this app, in a Google Forms
spreadsheet grown to 32 sheets. The obvious move is to backfill it into the
`sets`, `measurements` and `cardio` tables so every existing page just works.

Three things make that wrong.

**The data does not fit the schema, and forcing it would lose information.** The
form asked one question for everything, so a weigh-in is recorded as an
"exercise" of 1×1 at body weight; a set is sometimes `"65,95,115"` in the weight
column; a plank's "reps" are seconds. Coercing that into `SetRecord` means
either inventing values or dropping rows.

**It is history, and history is not editable.** Backfilled rows would sit in an
append-only table (ADR-0013) indistinguishable from rows logged today, so a
correction to the import would be indistinguishable from a correction to
training. Keeping it separate makes "this is the old tracker" a fact of the
storage, not a convention.

**It is already cold.** Every row is older than the 13-month hot window
(ADR-0012), so backfilling would write ~2000 items into DynamoDB for the age-out
job to move straight back out to Parquet.

**Decision.** Curate the workbook's **facts** — and only its facts — into
Parquet, publish that to each environment's archive bucket under `history/`, and
serve it through `/api/history/*`, read-only, queried with DuckDB (ADR-0025).

This is option 2 from Q02, and Q02's own test decided it: "show me my whole
training history" turned out to be a page the athlete actually wanted.

**Only four of the workbook's 32 sheets are imported.** The other 28 are
derived — pivots, dashboards, streak calendars, a ride forecaster. Importing one
would bake a 2021 spreadsheet's arithmetic into the data layer where nothing can
ever check it. Every number on the History page is recomputed in SQL from the
facts, so a disagreement with the old workbook is a question with an answer.

**Consequences.**

- The interactive pages keep their DynamoDB-only latency; nothing gained a
  cross-boundary union query.
- Publishing is an explicit operator command (`make publish-history ENV=…`), not
  a deploy step. The source holds body-composition data and `reference/` is
  gitignored — nothing leaves the machine because a build ran.
- An environment can legitimately hold no history, so every history route
  answers `available: false` rather than an empty chart.
- The exercise catalogue is derived from the log rather than transcribed from
  the workbook's `Type` column, which evaluates to `#VALUE!` on a third of its
  rows. A catalogue built from the log cannot contain a movement never performed
  nor omit one that was.

> **Lens.** Import the FACTS and recompute the derivations. A derived table
> imported as data is an answer with no question attached: it cannot be
> re-derived, cannot be checked, and silently carries whatever assumptions its
> author had at the time.

## ADR-0027 — Every view is a URL

**Status:** Accepted — supersedes the routing decision in ADR-0024's commentary

**Context.** The SPA used hash routing and held every filter in component state.
Both were defensible when the app had six pages and one chart. Neither survived
the history import: the value of a chart here is that it can be *pointed at* —
"look at squat volume in the 2022 block" is a sentence that should be a link.

Hash routing was chosen because it needs no server cooperation. That reason had
already expired: ADR-0024 moved the SPA fallback into the edge authenticator,
which rewrites **any** extensionless non-`/api/` path to `/index.html`. Real
paths therefore cost nothing.

**Decision.** Path routing, and **all filter state in the query string**.

- `/history/volume?grain=week&exercise=Barbell%20Back%20Squat` opens exactly
  that chart.
- The one-page History surface became six subpages, each its own address, so
  feedback can name one chart rather than a region of a long scroll.
- The exercise catalogue became a root page: it is a reference for the whole
  app, and filing it under history implied it only described the archive.

**Two rules make this real rather than decorative.**

*A control must never hold state the URL does not.* The failure is silent — the
chart changes, the address bar does not, and the link you send shows something
else. `useQueryParam` is the only state primitive these pages use.

*Writing a default REMOVES its parameter.* Otherwise every page accumulates
`?grain=month&window=all&environment=`, two identical views carry different
URLs, and the one parameter that was actually changed is buried.

**Consequences.**

- Filter changes use `replaceState`, so adjusting a range six times leaves one
  history entry rather than six. The URL still updates; only the back button
  differs.
- Nav is real `<a href>` with click interception, so ⌘-click, middle-click and
  "copy link address" all work. Buttons would have broken all three.
- e2e asserts the URL, not just the render — a router that shows the right page
  while leaving the address bar behind fails the entire point.

> **Lens.** If a view is worth discussing, it must be worth linking to. State
> that lives only in memory can be described but never *shown*, and a
> screenshot is what people fall back on when a URL cannot do the job.

## ADR-0028 — Plotly, and one chart implementation

**Status:** Accepted — supersedes the hand-drawn charts

**Context.** The SVG charts were hand-drawn on the reasoning that three
monotone series over a date axis need no library, and that a charting
dependency would outweigh the rest of the bundle. Both were true.

They stopped being true at nine charts across seven pages, needing hover
readouts, zoom over a five-year axis, legend toggling and stacked bars.
Building those is how "a small dependency-free chart" becomes a chart library
with no documentation and no tests.

**Decision.** `plotly.js-basic-dist-min`, loaded dynamically, with the theme
resolved from CSS custom properties at draw time.

- **basic**, not the full build: scatter and bar are every trace this app draws.
- **dynamic import** — genuine code-splitting, not a hidden optional dependency.
  Today, Block and Log never download it.
- **Colours read from `getComputedStyle`.** Plotly takes literals, so a theme
  cannot be applied by CSS; handing it `var(--muted)` renders black with no
  error, which is the worst kind of failure because it looks deliberate.
- **Charts redraw on theme change**, watched via `MutationObserver` on
  `data-theme` plus a `prefers-color-scheme` listener. The second is not
  redundant: the default "Auto" setting stamps no attribute at all.

**Consequences.** The hand-drawn `LineChart` and `BarChart` are deleted, and
the two pages that still used them moved over — one implementation, so a
feature added to charts is added to all of them.

> **Lens.** A dependency-free implementation is right until the requirements
> grow interaction. Count the *behaviours* being reimplemented, not the lines:
> hover, zoom, legend and axis formatting are a library's worth of work
> whatever the file size says.

## ADR-0029 — A block is superseded, never edited or deleted

**Status:** Accepted — a consequence of ADR-0013, made explicit

**Context.** "Can I delete or reset a block that has started?" had no answer
anywhere in the UI, which meant the honest answer — *no, and here is what to do
instead* — was indistinguishable from a missing feature.

Storage is append-only (ADR-0013) and the API role has no `DeleteItem`, so
neither editing nor deleting is available and neither should be added: the
guarantee that "what did I believe in March" stays answerable is worth more than
the convenience of a destructive edit.

**Decision.** Creating a block with an existing start date **supersedes** it.
The API resolves the current block as the latest start date on or before today,
tie-broken by **latest write**, and `/block-inputs` states plainly that it is
writing a replacement rather than editing.

That tie-break was a real bug and not a nicety: previously the winner was
whichever `blockId` sorted last — a UUID, so effectively random — and a
correction therefore took effect roughly half the time.

**Consequences.** Every version of every block stays queryable. The UI shows how
many blocks exist, so "you have five and this is the live one" is visible rather
than inferred. There is no destructive action to confirm, because there is none.

> **Lens.** When an architecture forbids an operation, the UI must NAME the
> substitute. An absent button reads as an unfinished feature; a stated
> substitute reads as a decision.

## ADR-0030 — Log one exercise at a time

**Status:** Accepted — supersedes the whole-session form

**Context.** The first logging page pre-filled a whole session and saved it in
one action, on the reasoning that "I did what it said" is the common case and
should be one confirmation.

The Google Form this app replaces did something different, and reading it
changed the design: it submitted **one exercise per response**. That looked like
a limitation of forms. It is not.

**Decision.** Each exercise is independently submittable and shows how many sets
it already carries.

Three things fall out of that, all of which the session-level form got wrong:

1. **You log as you go**, so closing the tab loses nothing.
2. **The count answers "where am I up to"** — the question you actually have
   after supersetting away and back, which no prescription can answer.
3. **A partial session is a real state**, so the overview can colour a session
   in-progress rather than binary done/not-done.

The form's other good idea is kept: a **comma-separated weight list**.
`60,70,80` is three sets at those loads with the same reps, which is how a
ramping set is actually written down.

**Consequences.** Completion is derived by folding observations, never stored —
a set already carries its own `blockId`, `week` and `day`, so no status field
exists that could disagree with the log.

> **Lens.** When replacing a tool, read what its constraints produced before
> discarding them. A form's "limitation" had been quietly encoding the right
> unit of work for four years.

## ADR-0031 — Log one SET at a time, not one exercise

**Status:** Accepted — supersedes ADR-0030's grain

**Context.** ADR-0030 moved logging from whole-session to whole-exercise, on
the evidence that the Google Form submitted one exercise per response. That was
the right direction and still the wrong grain.

An exercise is not one decision. A prescription of `x12, x12, x10, x8` is four
sets performed minutes apart, and between them you rack the bar, rest, and quite
often lose track. The question in the gym is never "have I done Military Press",
it is **"which set am I on"** — and an exercise-level control cannot express it.

The Edit button was the second mistake. It charged a click to editing the
numbers, treating that as the exception. It is not: the reps you actually get
are rarely the reps written down.

**Decision.** One row per prescribed set, always editable, with a single tick
that saves that set.

- **The unticked row IS the progress indicator.** No separate status to read.
- **Nothing is hidden.** Weight and reps are inputs on every row, pre-filled
  from the prescription where the program gives a definite number.
- **Rep counts are never forced.** A range or a max-reps set starts blank —
  pre-filling one invites confirming a lift nobody performed.
- **An extra row always exists** beyond the prescription. A fifth set when four
  were written is training, not a data-entry error.

The API returns the SETS, not a tally, because "was set three the heavy one" is
the question in front of you when you pick the bar back up.

**Consequences.** The common case is one tap per set with no typing. Completion
means every prescribed set, so a session goes green only when it is actually
finished — the overview gained a meaningful "in progress" as a side effect.

> **Lens.** Match the unit of interaction to the unit of DECISION, not to the
> unit of data. The two coincided for measurements and diverged for training,
> and the gap cost two rewrites to see.

## ADR-0032 — Free-text pickers need a browse affordance

**Status:** Accepted

**Context.** The accessory slots used `<input list>` with a `<datalist>`, chosen
because the source spreadsheet allowed free text and a `<select>` would refuse
every movement the catalogue had not seen.

It was unusable, and the reason is worth recording: browsers only surface
datalist suggestions **once you type**, render no indication that a list exists
at all, and provide no way to browse. Picking an accessory whose name you half
remember — the entire purpose of the control — was impossible.

**Decision.** A combobox: an input that filters, a visible control that opens
the whole list, keyboard navigation, and free text as a first-class outcome.

Its options come from a **canonical list transcribed from the Google Form**,
unioned with whatever the imported catalogue holds. The archive alone is not
enough: it contains only what was actually performed, so every movement offered
but never logged would silently vanish from the picker.

**Consequences.** One more component to own, and it must stay accessible —
`role="listbox"` on plain `div`s rather than on a `ul`, whose native semantics
would fight the ARIA ones.

> **Lens.** A control that permits anything still has to SHOW what is expected.
> Accepting free text is a capability; discovering the options is the feature.

## ADR-0033 — A block's identity is its start date

**Status:** Accepted — replaces the UUID, and subsumes ADR-0029's tie-break

**Context.** Blocks were identified by a UUID. That made two things awkward and
one thing wrong.

Awkward: a block had no name anyone could say, and sorting a list of them
required carrying the start date alongside and comparing on that instead.

Wrong: ADR-0029 established that creating a block with an existing start date
**supersedes** it, and the resolution was "latest start date, tie-broken by
latest write". The tie-break was necessary only because two blocks with the same
start date had different identities. Before that fix the winner was whichever
UUID sorted last — effectively random.

**Decision.** `blockId = B-YYYYMMDD`, derived from the start date.

- **It sorts.** Plain lexicographic order is chronological order, so a list, a
  DynamoDB range query and a `.sort()` all agree with no comparator.
- **Supersede falls out of the key.** Two blocks starting the same day now have
  the same identity, which is what "the same block, corrected" always meant. The
  tie-break stays as a `createdAt` comparison between versions of one id, which
  is a much smaller claim.
- **A session is addressable**: `B-20270810-W5D1` names one session, in a
  message, without a link.

The display form spells the month — `B-2027AUG10` — because `B-20270810` is
unreadable at a glance and `2027-08-10` reintroduces the day/month ambiguity
this app already removed from its date formatting.

**Consequences.** Blocks created before this keep their UUIDs; storage is
append-only so they cannot be rewritten, and every helper passes an unrecognised
identifier through unchanged rather than rendering a lie.

> **Lens.** When an entity has a natural key, use it. A surrogate id buys
> uniqueness you already had and costs you ordering, readability, and — here —
> a correctness rule that had to be enforced separately.

## ADR-0034 — The curated catalogue is the single source of truth

**Status:** Accepted — supersedes the canonical list of ADR-0032

**Context.** What an exercise *is* was defined in three places: a hardcoded menu
per accessory slot, a canonical list transcribed from the Google Form, and the
classifications derived during history curation. They disagreed, and the
disagreement was visible — Romanian Deadlift appears in the log five times and
is unambiguously a hinge, and it could not be picked as a deadlift variation
because that slot's menu was a literal of four strings.

**Decision.** One catalogue, stored and curated, on **two axes**:

- **Equipment** — "what do I need". The axis history is filtered by.
- **Movement** — "what does this train". The axis a prescribed accessory slot is
  filled from: the program asks for a horizontal pull, and which one is the
  athlete's choice.

A slot declares the movement it requires (`SLOT_MOVEMENT`) and its picker is the
catalogue filtered by that. There is no per-slot list left to go stale.

A **seed** ships in the program package so a fresh environment is useful before
anyone curates anything; stored entries override it by name, lower-cased so
"Barbell row" and "Barbell Row" cannot split one movement's history in two.

**Consequences.** `/exercises` stopped being a read-only report and became the
place the app is configured — editing a row immediately changes what can be
prescribed. Movement had to be a real classification rather than something
inferred from the name, because prefix-matching a name is exactly the guessing
this replaced.

> **Lens.** When a value is consulted from three places, it has three
> definitions. Make it data with one home before adding a fourth reader.
