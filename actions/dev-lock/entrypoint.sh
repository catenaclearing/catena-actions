#!/bin/sh
# Acquire the dev lock. Fails the step only when the deploy must stop (see src/dev_lock/runner.py).
exec python -m dev_lock acquire
