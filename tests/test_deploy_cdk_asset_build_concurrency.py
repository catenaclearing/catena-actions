"""How composite/deploy-cdk passes --asset-build-concurrency to `cdk deploy` (PLAT-543).

The CDK CLI gives --asset-build-concurrency a command-line default of 1, which overrides an "assetBuildConcurrency"
in a repo's cdk.json, so the only way for a repo to build its Docker images in parallel is through this input.
"""

from pathlib import Path

import yaml


ACTION = yaml.safe_load((Path(__file__).resolve().parent.parent / "composite" / "deploy-cdk" / "action.yaml").read_text())
DEPLOY = next(item for item in ACTION["runs"]["steps"] if item.get("name") == "CDK Deploy")


def test_the_input_is_optional_and_defaults_to_cdks_own_default():
    """Repos that don't set it keep building one image at a time, exactly as before."""
    assert ACTION["inputs"]["asset_build_concurrency"]["required"] is False
    assert ACTION["inputs"]["asset_build_concurrency"]["default"] == "1"


def test_the_deploy_passes_the_input_on_the_command_line():
    assert DEPLOY["env"]["ASSET_BUILD_CONCURRENCY"] == "${{ inputs.asset_build_concurrency }}"
    assert '--asset-build-concurrency "$ASSET_BUILD_CONCURRENCY"' in DEPLOY["run"]


def test_the_rest_of_the_deploy_command_is_unchanged():
    assert 'npx -y "aws-cdk@$CDK_VERSION" deploy "$STACK_NAME"' in DEPLOY["run"]
    assert '--force --tags "catena:managed-by=$THIS_REPO" $EXCLUSIVELY' in DEPLOY["run"]
