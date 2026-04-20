SHELL=/bin/bash
GITHUB_TOKEN ?= $(error GITHUB_TOKEN is not set. Please provide a GitHub token to login to GitHub Container Registry. The token must have `read:packages` scope.)
PROJECTS :=

.DEFAULT_GOAL := help

define run_in_projects
	@failed_projects=""; \
	for project in $(PROJECTS); do \
		echo "Running '$@' in $$project"; \
		if ! $(MAKE) -C "$$project" $@ $(MAKEOVERRIDES); then \
			failed_projects="$$failed_projects $$project"; \
		fi; \
	done; \
	if [ -n "$$failed_projects" ]; then \
		echo "Target '$@' failed in projects:$$failed_projects"; \
		exit 1; \
	fi
endef

.PHONY: help
help: ## Shows this help text
	@grep -h -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | sort | awk 'BEGIN {FS = ":.*?## "}; {printf "\033[36m%-30s\033[0m %s\n", $$1, $$2}'

.PHONY: init
init: clean install test ## Clean environment and reinstall all dependencies

.PHONY: clean
clean: ## Removes project virtual env and untracked files
	$(run_in_projects)
	@echo "Removing untracked files from $(CURDIR)"
	@rm -rf .venv .pytest_cache .ruff_cache .mypy_cache cdk.out build dist node_modules
	@find . \( -type d \( -name "__pycache__" -o -name "*.egg-info" \) -o -type f \( -name ".coverage" -o -name "*.pyc" -o -name "*.pyo" \) \) -prune -exec rm -rf {} +
	-poetry env remove --all

.PHONY: install
install: ## Install the project dependencies and pre-commit using Poetry
	$(run_in_projects)
	@poetry sync --all-groups --all-extras
	@poetry run pre-commit install --hook-type pre-commit --hook-type commit-msg --hook-type pre-push

.PHONY: update
update: ## Update the project dependencies using Poetry
	$(run_in_projects)
	@poetry update --sync --with lint,test,checkov,dev

.PHONY: lock
lock: ## Regenerate the Poetry lock files
	$(run_in_projects)
	@poetry lock

.PHONY: fix-lock
fix-lock: ## Regenerate and stage the Poetry lock files
	$(run_in_projects)
	@poetry lock --regenerate
	@git add poetry.lock

.PHONY: test
test: ## Run tests
	$(run_in_projects)
	@poetry run python -m pytest

.PHONY: lint
lint: ## Apply linters to all files
	$(run_in_projects)
	@poetry check --lock
	@poetry run yamllint .
	@poetry run ruff check --no-fix $(RUFF_ARGS) --config pyproject.toml .
	@poetry run ruff format --check $(RUFF_ARGS) --config pyproject.toml .

.PHONY: format
format: ## Format Python source files
	$(run_in_projects)
	@poetry run ruff check --fix $(RUFF_ARGS) --config pyproject.toml .
	@poetry run ruff format $(RUFF_ARGS) --config pyproject.toml .

.PHONY: checkov
checkov: test ## Run Checkov against IAC code
	@poetry run checkov --config-file .checkov --baseline .checkov.baseline

.PHONY: checkov-baseline
checkov-baseline: test ## Run checkov and create a new baseline for future checks
	@poetry run checkov --config-file .checkov --create-baseline --soft-fail
	@mv cdk.out/.checkov.baseline .checkov.baseline
