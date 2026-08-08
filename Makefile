# fit — the single command-and-control surface.
#
# Two rules govern what may go where:
#   1. `ci` is free, offline and deterministic. Nothing that spends money or
#      touches AWS may be a dependency of it — those are SIBLING targets.
#   2. Nothing ever `cd`s. Every tool is invoked with its own directory flag
#      (`bun run --cwd`, `uv run --directory`, `terraform -chdir`).

SHELL := /usr/bin/env bash
.SHELLFLAGS := -euo pipefail -c
.DEFAULT_GOAL := help

AWS_PROFILE ?= fullsend-jpai
AWS_REGION  ?= ap-southeast-2
ENV         ?= dev
STACK       ?=

export AWS_PROFILE
export AWS_REGION

# ---------------------------------------------------------------------------
# Help
# ---------------------------------------------------------------------------

.PHONY: help
help: ## Show this help
	@echo "fit — targets"
	@echo
	@grep -hE '^[a-zA-Z0-9_/-]+:.*?## .*$$' $(MAKEFILE_LIST) \
	  | sort \
	  | awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-24s\033[0m %s\n", $$1, $$2}'
	@echo
	@echo "Variables: ENV=$(ENV)  AWS_PROFILE=$(AWS_PROFILE)  AWS_REGION=$(AWS_REGION)"

# ---------------------------------------------------------------------------
# The inner loop — free, offline, deterministic
# ---------------------------------------------------------------------------

.PHONY: install
install: ## Install all JS dependencies
	bun install

.PHONY: fix
fix: ## Auto-format and auto-fix everything fixable
	bunx --bun @biomejs/biome check --write .
	terraform fmt -recursive infra

.PHONY: format-check
format-check: ## Verify formatting without changing files
	bunx --bun @biomejs/biome format .
	terraform fmt -check -recursive infra

.PHONY: lint
lint: ## Lint TypeScript
	bunx --bun @biomejs/biome lint .

.PHONY: typecheck
typecheck: ## Typecheck every TypeScript workspace
	# EVERY workspace, and the list must match app-ci.yml. An earlier version
	# checked only packages/program, so `make ci` went green locally while CI
	# failed on a type error in tools/ — which is the exact failure mode a local
	# gate exists to prevent.
	bun run --cwd packages/program typecheck
	bun run --cwd api typecheck
	bun run --cwd frontend typecheck
	bun run --cwd tools typecheck
	bun run --cwd e2e typecheck

.PHONY: test
test: ## Run unit tests
	bun test packages

.PHONY: ci
ci: format-check lint typecheck test tf-check ## The gate before pushing. Free and offline.
	@echo "==> ci green"

# ---------------------------------------------------------------------------
# Terraform — static checks only. CI is the only actor that plans or applies
# against real state (ADR-0006).
# ---------------------------------------------------------------------------

.PHONY: tf-check
tf-check: ## fmt-check + validate every stack. No cloud, no state.
	@set -e; \
	terraform fmt -check -recursive infra; \
	for dir in infra/stacks/*/; do \
	  [ -f "$$dir/main.tf" ] || continue; \
	  echo "==> validate $$dir"; \
	  terraform -chdir="$$dir" init -backend=false -input=false -no-color >/dev/null; \
	  terraform -chdir="$$dir" validate -no-color; \
	done

.PHONY: diagrams
diagrams: ## Check every Mermaid diagram for WCAG contrast and complexity
	# NOT part of `ci`, and that is a limitation rather than a choice: the
	# scripts live in `.claude/skills/`, which is not tracked in this
	# repository, so a CI runner has no copy of them. Run this locally before
	# changing any diagram — both gates must exit 0.
	@if [ -d .claude/skills/mermaidjs_diagrams/scripts ]; then \
	  bun run .claude/skills/mermaidjs_diagrams/scripts/mermaid_contrast.ts \
	    README.md ARCHITECTURE.md .github/actions/terraform/README.md; \
	  bun run .claude/skills/mermaidjs_diagrams/scripts/mermaid_complexity.ts \
	    README.md ARCHITECTURE.md .github/actions/terraform/README.md; \
	else \
	  echo "mermaidjs_diagrams skill not present — diagrams unchecked"; \
	fi

.PHONY: tf-docs
tf-docs: ## Regenerate the module input/output tables
	bun run tools/tf-docs.ts

# ---------------------------------------------------------------------------
# Bootstrap — the ONE layer a human runs (ADR-0004). Idempotent, re-runnable.
# ---------------------------------------------------------------------------

.PHONY: bootstrap
bootstrap: ## CloudFormation trust floor: OIDC provider, state bucket, deployer role
	infra/bootstrap/bootstrap_cfn.sh

.PHONY: bootstrap-dryrun
bootstrap-dryrun: ## Same, but only create changesets for review
	DRYRUN=1 infra/bootstrap/bootstrap_cfn.sh

.PHONY: bootstrap-tags
bootstrap-tags: ## Activate Project/Environment as cost-allocation tags (ADR-0014)
	infra/bootstrap/activate_cost_tags.sh

.PHONY: github-environments
github-environments: ## Create dev/test/prod GitHub Environments and their promotion gates
	infra/bootstrap/github_environments.sh

.PHONY: entra
entra: ## Create or converge the EntraID app registration for OAuth
	infra/entra/entra_app.sh

# ---------------------------------------------------------------------------
# Local development
# ---------------------------------------------------------------------------

.PHONY: up
up: ## Start local backing services (DynamoDB Local)
	docker compose up -d

.PHONY: down
down: ## Stop local backing services
	docker compose down

.PHONY: seed
seed: up ## Create local tables and load sample data
	bun run tools/seed.ts

.PHONY: dev
dev: seed ## Run the whole app locally: API + SPA
	bun run tools/dev.ts

# ---------------------------------------------------------------------------
# Agentic access — mint a session from the environment's SSM key (ADR-0011)
# ---------------------------------------------------------------------------

.PHONY: token
token: ## Mint a short-lived session cookie for ENV=<local|dev|test|prod>
	bun run tools/mint-token.ts --env $(ENV)

# ---------------------------------------------------------------------------
# End-to-end — sibling of ci, never a dependency
# ---------------------------------------------------------------------------

.PHONY: smoke
smoke: ## Check every API route of ENV answers, and that anonymous callers do not
	bun run tools/smoke.ts --env $(ENV)

.PHONY: e2e
e2e: ## Playwright against ENV (default local)
	bun run --cwd e2e test -- --project=$(ENV)

.PHONY: shots
shots: ## Screenshot every page of ENV, light and dark, into tmp/screenshots/
	bun run e2e/screenshots.ts --env $(ENV)

.PHONY: cold-start
cold-start: ## Stand up a whole environment in dependency order (ADR-0022)
	# workflow_dispatch resolves only against the DEFAULT branch, so this
	# answers 404 until cold-start.yml has been merged to main.
	gh workflow run cold-start.yml -f environment=$(ENV)
	@echo "Dispatched. Watch it with: gh run watch"

.PHONY: e2e-install
e2e-install: ## Install Playwright browsers
	bun run --cwd e2e exec playwright install --with-deps chromium

# ---------------------------------------------------------------------------
# Diagnostics
# ---------------------------------------------------------------------------

.PHONY: whoami
whoami: ## Show which AWS identity and region the Makefile would use
	@aws sts get-caller-identity --output table
	@echo "region: $(AWS_REGION)  env: $(ENV)"

.PHONY: urls
urls: ## Print every environment's URL
	@echo "local  http://localhost:5173"
	@echo "dev    https://fit-dev.jpeak.ai"
	@echo "test   https://fit-test.jpeak.ai"
	@echo "prod   https://fit.jpeak.ai"
