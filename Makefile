node_modules: package-lock.json
	@npm ci --no-fund --no-audit
	@touch node_modules

@PHONY: lint
lint: node_modules
	@npx eslint .
	@npx tsc

@PHONY: fmt
fmt: node_modules
	@npx eslint --fix .

@PHONY: test
test: node_modules
	@BACKPORTER_GITHUB_TOKEN="$${BACKPORTER_GITHUB_TOKEN:-$$(gh auth token 2>/dev/null)}" \
	BACKPORTER_GITEA_FORK="$${BACKPORTER_GITEA_FORK:-GiteaBot/gitea}" \
	node --test 'src/**/*_test.ts'
