# Release notes howto

One file per released version, in this directory: `v` + the version with **every dot replaced by an
underscore** + `.md`. So `1.1.0` is `v1_1_0.md` and the prerelease `2.0.0-beta.3` is
`v2_0_0-beta_3.md`. Notes for the 0.x line are archived under `v0/`.

**The release pipeline reads the file for the version being shipped.** Its `#` heading becomes the
GitHub Release title and the rest becomes the Release body. A version with no file here gets a
Release with a blank body — nothing is synthesised to fill it. So the notes are written before a
release is dispatched.

**The pipeline says so before it publishes.** `validate-inputs`, the release run's first job, runs
`scripts/release-notes-preflight.mjs` and raises a warning annotation naming the exact file it
looked for. It warns and never blocks: a missing prose file must not stop a shipping fix, so the
dispatcher decides whether to cancel and write the notes or let the blank body stand.

## Conventions

- **The H1 is normally just the version**, as in `# v2.0.0-beta.3`. A descriptive suffix — as in
  `# v2.0.0-beta.2 The Alignment Check` — is earned by a release carrying a new feature, or a change
  that is big **to someone using the tool**. Work that was significant to the project and is a
  non-event for a user keeps the flat heading.
- **Most files are three to seven lines of text.** Concision is the default, not a fallback for a
  release with little in it.
- **Release notes are documentation.** When something genuinely important ships, one or two
  paragraphs for that feature is enough.

A file that is nothing but its H1 is a valid release note: the Release page then shows that title
and nothing under it.

- **While `latest` points at a prerelease, say what that does to a library consumer.** A known-good
  prerelease is deliberately promoted to `latest`, so `npm i @gaunt-sloth/<pkg>` writes a
  `^2.0.0-beta.N` range that admits every later prerelease of the same version — the user is
  subscribed to a line where breaking changes are still permitted, and nothing they typed said so.
  It is not a breaking change and does not belong under that heading; it is a consequence of the
  channel and is worth one bullet on the release that introduces it. Installing the CLI globally is
  unaffected, since that writes no manifest.

- **Every link in a notes file is a full `https://` URL, pinned to that release's own tag.** The
  reason is that **a notes file is read in two places, and neither relative form works in both.**

  On the **Release page**, GitHub prepends `/<owner>/<repo>/blob/<that release's tag>/` to a
  non-absolute target and then normalizes it. So a leading `..` climbs past the tag and consumes
  it: `../docs/COMMANDS.md` becomes `blob/docs/COMMANDS.md`, which names a branch called `docs` and
  returns 404. A target with no `..` resolves there — `docs/COMMANDS.md` becomes
  `blob/<tag>/docs/COMMANDS.md`.

  In the **repo-file view** the base is the notes file's own directory, so the two swap: the `..`
  form recovers `docs/COMMANDS.md` and works, while `docs/COMMANDS.md` means
  `release-notes/docs/COMMANDS.md`, which does not exist.

  Each relative form is therefore dead exactly where the other works, and **only an absolute URL
  survives both.** Write
  `https://github.com/pukeko-robotics/gaunt-sloth/blob/v2.0.0-beta.6/docs/COMMANDS.md#api-ag-ui`.
  The tag is the one this release will create, so **the link returns 404 until the release is cut**
  and resolves from then on; that is expected and is not a reason to repoint it at `main`. A Release
  page is a permanent record of one version and a tag is immutable, so a tag-pinned link stays
  correct where a `main` link decays the day a document is renamed — and it deliberately serves the
  documentation **as that release shipped it**, so an old Release page keeps describing the version
  it belongs to rather than silently acquiring today's docs. The failure is silent in the
  worst direction — the link renders, is clickable, and looks right in the source and in every
  editor preview — so `validate-inputs` warns about one before anything is published, naming the
  file, the link and the URL it should have been. Like the missing-notes warning it never blocks.
  This binds the `v<version>.md` files, which become Release bodies; a link in this howto is an
  ordinary repository link and is relative as usual.

## Style

Dry and factual, not excited or marketing-oriented. `v2_0_0-beta_3.md` is the shape to follow.
Write what a user can now do, or what changed under them. Leave out unit tests, integration tests
and other development-specific detail.

## Writing them

1. Review the changes from the latest tag to HEAD.
2. List this directory and read a few recent files.
3. Write the file for the version in `packages/core/package.json` — the release ships the version
   the repository is on now, and bumps to the next one afterwards
   ([maintenance/RELEASE-HOWTO.md](../maintenance/RELEASE-HOWTO.md)).
4. Present the notes to the user and ask for confirmation.

## Structure

A short file needs no headings at all — bullets under the H1 are enough, and most releases end
there. A release large enough to sort uses the sections that apply, and only those:

- **New Features**: major functionality additions
- **Potentially Breaking Changes**: changes that require the user to do something
- **Bug Fixes**: resolved issues
- **Improvements**: refactoring, performance, architecture
- **Maintenance**: dependency updates, minor fixes

For a breaking change, say what the user has to do about it.
