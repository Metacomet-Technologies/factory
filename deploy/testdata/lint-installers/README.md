# Installer lint fixtures

Inputs for `deploy/test-lint-installers.py`. They are never run. Each
`install-no-<check>.sh` and `rollback-no-<check>.sh` differs from a compliant
fixture by one property, and `deploy/lint-installers.sh` must fail only that check.

The test writes the `lint-*.service` units the fixtures name into a temporary
copy. They are not tracked because `scripts/release/test-release.py` treats every
tracked unit under `deploy/` as deployable.

- Compliant: `install-good.sh`, `install-good-oneshot.sh` (bounded oneshot health
  check), `install-called-root.sh` (root guard in a called function) and
  `rollback-good.sh`.
- One failure each: `install-no-strict.sh`, `install-no-root.sh`,
  `install-late-root.sh`, `install-inverted-root.sh`,
  `install-root-after-mutation.sh`, `install-no-preflight.sh`, `install-no-trap.sh`,
  `install-no-snapshot.sh`, `install-touch-snapshot.sh`, `install-no-health.sh`,
  `install-no-health-oneshot.sh`, `install-timeout-true.sh`, `install-max-time-zero.sh`,
  `install-m-zero.sh`, `install-timeout-zero.sh`, `install-loop-unbounded.sh`,
  `install-no-rollback.sh` and `rollback-no-snapshot.sh`.
- The unnamed rollback fails `rollback` because nothing here names it. Do not
  name it in this file.
