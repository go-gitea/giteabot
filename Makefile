SRC_FILES := $(shell find src -type f -name '*.ts')

@PHONY: lint
lint:
	@deno lint --quiet
	@deno fmt --quiet --check
	@deno check --quiet $(SRC_FILES)

@PHONY: fmt
fmt:
	@deno fmt --quiet

@PHONY: test
test:
	@BACKPORTER_GITHUB_TOKEN="$${BACKPORTER_GITHUB_TOKEN:-$$(gh auth token 2>/dev/null)}" \
	BACKPORTER_GITEA_FORK="$${BACKPORTER_GITEA_FORK:-GiteaBot/gitea}" \
	deno test --quiet -A
