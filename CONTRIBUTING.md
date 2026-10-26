# Contributing

Use feature/fix branches and PRs targeting `develop`. Reviewed integration goes
to `main` through a separate PR; pushes and green checks are not releases.

Keep user documentation concise and current. README and wiki explain setup,
usage and limitations; release notes describe changes. Do not publish internal
work logs or debugging narratives in user guides.

The launcher uses semantic versioning (`major.minor.patch`), starting at `0.1.0`.
Use patch releases for compatible fixes and minor releases for new features;
before `1.0.0`, breaking changes may arrive in a minor release. Runtime builds
are versioned separately. Keep `package.json` and `package-lock.json` in sync.

```sh
npm ci
npm run build
npm run test:runtime-tools
npm run test:ci-tools
```

Keep one shared runtime. Use disposable test directories, never a user's active
game installation, saves or Xodus checkout. Keep credentials, raw diagnostics,
prefixes and private work records outside Git. Include redacted reproduction steps,
versions and actual test results in bug reports and PRs.

Develop and pull requests run source checks without distribution builds. Only
main builds launcher/backend/runtime candidates, once per relevant source change.
Promotion reuses those exact files without rebuilding.
Use `[source-only]` in the main integration commit subject when only source
publication is intended. Source checks still run, but launcher packaging and
backend compilation are skipped. A normal main integration or explicit workflow
dispatch retains the usual candidate build behavior.
Stable publication requires explicit maintainer approval
for the exact tested artifact, with no rebuild after validation. The approval
record is [release-validation.json](.github/release-validation.json).

Detailed guides are prepared for the [wiki](https://github.com/domsvoboda/xodus-nexus/wiki)
(currently pending). Runtime reconstruction instructions and source/license
locks remain alongside the [build scripts](scripts/SHARED_RUNTIME.md).

For interface translations and Tolgee import/export, see
[Translating the launcher](docs/TRANSLATING.md).
