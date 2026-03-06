---
name: release
description: >
  Release gh-pico: bump version, generate changelog, tag, and push to trigger
  the GitHub Actions release workflow. Use this skill whenever the user says
  "release", "cut a release", "ship it", "bump version", "publish a new version",
  "tag a release", "create release", or anything that implies they want to ship
  a new version of gh-pico. Also trigger when the user asks about the release
  process, release checklist, or what version is next.
---

# Release Skill — gh-pico

This skill handles the full release flow for the `gh-pico` GitHub Copilot CLI extension.
The project uses tag-triggered GitHub Actions: pushing a `v*` tag runs tests, builds,
and creates a GitHub Release with auto-generated notes.

## Release Flow

### 1. Pre-flight Checks

Run these checks first and stop if any fail. Report all failures together rather than
stopping at the first one — it's more helpful to see everything that needs fixing at once.

```bash
# Must be on main
git branch --show-current   # expect: main

# Working tree must be clean
git status --porcelain       # expect: empty

# Remote must be up-to-date
git fetch origin main
git diff --quiet HEAD origin/main  # expect: no diff

# Tests must pass
npm test                     # or: bun x vitest run

# Build must succeed
npm run build                # tsc
```

If any check fails, tell the user exactly what's wrong and how to fix it.
Don't proceed until all checks pass.

### 2. Determine Version Bump

Read the current version from `package.json`. Ask the user what kind of bump they want:

- **patch** (0.1.0 → 0.1.1) — bug fixes, small changes
- **minor** (0.1.0 → 0.2.0) — new features, backward-compatible
- **major** (0.1.0 → 1.0.0) — breaking changes

Show recent commits since the last tag (or all commits if no tags exist) to help
the user decide:

```bash
# Show commits since last tag, or all if no tags
LAST_TAG=$(git describe --tags --abbrev=0 2>/dev/null || echo "")
if [ -n "$LAST_TAG" ]; then
  git --no-pager log --oneline "$LAST_TAG"..HEAD
else
  git --no-pager log --oneline
fi
```

Use the `ask_user` tool to ask for bump type — don't guess.

### 3. Update Version

Bump the version in `package.json` using npm:

```bash
npm version <patch|minor|major> --no-git-tag-version
```

The `--no-git-tag-version` flag prevents npm from creating its own commit and tag —
we want to control that ourselves so we can include the changelog update in the same commit.

### 4. Generate Changelog

Update (or create) `CHANGELOG.md` at the repo root. The format follows
[Keep a Changelog](https://keepachangelog.com/):

```markdown
# Changelog

## [0.2.0] — 2026-03-05

### Added
- Feature X (#12)

### Fixed
- Bug Y (#15)

### Changed
- Refactored Z

## [0.1.0] — 2026-02-20

- Initial release
```

To generate the entries, look at commits since the last tag and categorize them
by their conventional commit prefix:

| Prefix | Section |
|--------|---------|
| `feat` | Added |
| `fix` | Fixed |
| `refactor`, `perf` | Changed |
| `docs` | Documentation |
| `test`, `ci`, `build`, `chore` | Other (include only if notable) |
| no prefix | Changed |

If a `CHANGELOG.md` already exists, prepend the new version section after the `# Changelog`
heading. Don't touch existing entries.

Use today's date in YYYY-MM-DD format.

### 5. Commit, Tag, and Push

```bash
# Stage the version bump and changelog
git add package.json package-lock.json CHANGELOG.md

# Commit
git commit -m "release: v<NEW_VERSION>" \
  -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"

# Tag
git tag "v<NEW_VERSION>"

# Push commit and tag
git push origin main
git push origin "v<NEW_VERSION>"
```

After pushing, tell the user:
- The tag `v<NEW_VERSION>` has been pushed
- The GitHub Actions release workflow will run automatically
- They can watch it at: `https://github.com/<owner>/<repo>/actions`
- The GitHub Release will appear at: `https://github.com/<owner>/<repo>/releases`

### 6. Verify (Optional)

If the user wants to wait for confirmation, watch the workflow:

```bash
gh run list --workflow=release.yml --limit=1
```

## Edge Cases

- **No previous tags**: This is the first release. All commits go into the changelog.
- **Lock file changes**: If `package-lock.json` or `bun.lock` changed from the version
  bump, stage them too. Check both since the project supports both npm and bun.
- **Dirty working tree**: If there are uncommitted changes, suggest the user either
  commit them first or stash them. Don't release with uncommitted work.
- **Not on main**: Ask the user if they meant to release from a different branch.
  Usually they just forgot to switch.
