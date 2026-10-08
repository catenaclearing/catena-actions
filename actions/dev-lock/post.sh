#!/bin/sh
# Release this run's share of the dev lock. Runs even when the job failed or was cancelled, and never fails the job.
exec python -m dev_lock release
