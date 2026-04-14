SHELL=/bin/bash
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
	@rm -rf .venv build dist .pytest_cache node_modules .coverage .ruff_cache cdk.out .mypy_cache
	@find . -type d -name "__pycache__" -prune -exec rm -rf {} +
	@find . -type f \( -name "*.pyc" -o -name "*.pyo" \) -delete
	@find . -type d -name "*.egg-info" -prune -exec rm -rf {} +
	-poetry env remove --all

.PHONY: install
install: ## Install the project dependencies and pre-commit using Poetry
	$(run_in_projects)
	@poetry install --all-groups
	@poetry run pre-commit install --hook-type pre-commit --hook-type commit-msg --hook-type pre-push

.PHONY: update
update: ## Update the project dependencies using Poetry
	$(run_in_projects)
	@poetry update --with lint,test,checkov,dev

.PHONY: lock
lock: ## Regenerate the Poetry lock file
	$(run_in_projects)
	@poetry lock

.PHONY: fix-lock
fix-lock: ## Regenerate and stage the Poetry lock file
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
	@poetry run ruff check --no-fix .
	@poetry run ruff format --check .

.PHONY: format
format: ## Format Python source files
	$(run_in_projects)
	@poetry run ruff check --fix .
	@poetry run ruff format .

.PHONY: checkov
checkov: test ## Run Checkov against IAC code
	@poetry run checkov --config-file .checkov --baseline .checkov.baseline

.PHONY: checkov-baseline
checkov-baseline: test ## Run checkov and create a new baseline for future checks
	@poetry run checkov --config-file .checkov --create-baseline --soft-fail
	@mv cdk.out/.checkov.baseline .checkov.baseline
