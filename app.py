import aws_cdk as cdk
from catena_cdk.environments import UsEast1Environments as Envs


app = cdk.App()

# Create an empty stack to validate the deploy action
cdk.Stack(
    scope=app,
    id="DummyActions-Development",
    env=Envs.development,
)

# Create an empty stack to validate the deploy action
cdk.Stack(
    scope=app,
    id="DummyActionsStaticSite-Development",
    env=Envs.development,
)

app.synth()
