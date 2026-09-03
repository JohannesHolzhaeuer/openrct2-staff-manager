# Contributing

Thanks for your interest in improving OpenRCT2 Staff Manager! This project is currently maintained by a single
developer, but the workflow below still applies to every change, including your own.

## Workflow

- **No direct pushes to `main`.** All changes go through a pull request, even for the sole maintainer.
- **Pull requests require passing CI**, but do not require a second approver (there isn't one).
- Releases are fully automated by [release-please](https://github.com/googleapis/release-please); you never bump
  the version or edit `CHANGELOG.md` by hand.

### Repository settings (configure once in GitHub UI)

1. **Rulesets → New branch ruleset** targeting `main`:
   - Require a pull request before merging.
   - Required approvals: **0**.
   - Require status checks to pass: select the `build` job from the *CI* workflow (and `commitlint` if desired).
   - Block force pushes.
   - Do **not** allow bypass, so even repo admins must go through a PR.
2. **Settings → Actions → General → Workflow permissions**: enable "Allow GitHub Actions to create and approve
   pull requests" so the `release-please` bot can open release PRs.
3. **Settings → General → Releases**: enable **Immutable releases**. Because immutable releases cannot be edited
   after publishing, the release workflow uploads assets and rewrites the release notes while the release is
   still a draft, and only removes the draft flag as its last step.

## Commit messages (Conventional Commits)

Commit messages are linted locally via a Husky `commit-msg` hook and re-checked in CI on every pull request using
[commitlint](https://commitlint.js.org/). Use the format:

```
<type>(optional-scope): <description>
```

Common types used by this project (see `.release-please-config.json` for how each type affects the changelog and
version bump):

| Type       | Effect                                             |
| ---------- | --------------------------------------------------- |
| `feat`     | New feature — triggers a minor version bump (0.x)   |
| `fix`      | Bug fix — triggers a patch version bump             |
| `perf`     | Performance improvement                              |
| `refactor` | Code change that neither fixes a bug nor adds a feature |
| `docs`     | Documentation only changes                           |
| `build`    | Changes to the build system or dependencies          |
| `chore`    | Other changes that don't modify source or test files (hidden from changelog) |
| `style`    | Formatting only changes (hidden from changelog)      |
| `test`     | Adding or fixing tests (hidden from changelog)       |

Add a `!` after the type/scope (e.g. `feat!:`) or a `BREAKING CHANGE:` footer to signal a breaking change.

## Releasing

1. Merge conventional-commit PRs into `main` via the required PR flow.
2. `release-please` automatically opens/updates a "release PR" with the bumped version and changelog.
3. Merge that PR (also via a PR, no direct push) to trigger the `Release` workflow, which:
   - Creates a **draft** GitHub Release and Git tag.
   - Builds the plugin bundle and uploads `dist/staff-manager.js` as a release asset.
   - Rewrites the release notes with a friendlier summary and an installation section.
   - Publishes the release (removing the draft flag) as the final step.

No `npm publish` step exists or is required — this package is not published to npm.
