ESLINT_FILES := src *.ts
ESLINT_ARGS := --color --max-warnings=0

.PHONY: help
help: Makefile ## print Makefile help information.
	@awk 'BEGIN {FS = ":.*##"; printf "\nUsage:\n  make \033[36m[TARGETS] default target: help\033[0m\n\n\033[35mTargets:\033[0m\n"} /^[0-9A-Za-z._-]+:.*?##/ { printf "  \033[36m%-45s\033[0m %s\n", $$1, $$2 }' Makefile

.PHONY: lint
lint: lint-js ## lint everything

.PHONY: lint-fix
lint-fix: lint-js-fix ## lint everything and fix issues

.PHONY: lint-js
lint-js: node_modules ## lint js and ts files
	pnpm exec eslint $(ESLINT_ARGS) $(ESLINT_FILES)
	pnpm exec tsc

.PHONY: lint-js-fix
lint-js-fix: node_modules ## lint js and ts files and fix issues
	pnpm exec eslint $(ESLINT_ARGS) $(ESLINT_FILES) --fix
	pnpm exec tsc

.PHONY: test
test: node_modules ## run tests
	INPUT_GITHUB_TOKEN="$${INPUT_GITHUB_TOKEN:-$$(gh auth token 2>/dev/null)}" \
	INPUT_GITEA_FORK="$${INPUT_GITEA_FORK:-GiteaBot/gitea}" \
	pnpm exec vitest

node_modules: pnpm-lock.yaml
	pnpm install --frozen-lockfile
	@touch node_modules
