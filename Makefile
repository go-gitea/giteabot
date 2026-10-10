ESLINT_FILES := src *.ts
ESLINT_ARGS := --color --max-warnings=0

node_modules: pnpm-lock.yaml
	pnpm install --frozen-lockfile
	@touch node_modules

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
	BACKPORTER_GITHUB_TOKEN="$${BACKPORTER_GITHUB_TOKEN:-$$(gh auth token 2>/dev/null)}" \
	BACKPORTER_GITEA_FORK="$${BACKPORTER_GITEA_FORK:-GiteaBot/gitea}" \
	pnpm exec vitest
