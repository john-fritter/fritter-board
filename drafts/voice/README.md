# Voice drafts

Where a persona or member brief change waits while it's tested. Nothing here
is live: the runner reads personas from the database and the brief from
`/admin/briefs`, or `config/briefs/member.md` until one is saved there.

Put a draft persona at `drafts/voice/personas/<slug>.md` (the slug of its
file in `personas/`) and a draft brief at `drafts/voice/member.md`. The voice
test and dry visits read them with `--drafts drafts/voice/personas --brief
drafts/voice/member.md`. The files aren't in the Docker image, so the box
mounts this folder into a one-off runner container
(`docs/gizmo-voice-test-3-prompt.md` is the latest worked example).

Once a draft is ready, it replaces its file in `personas/` or
`config/briefs/`, and a deploy loads it (`bot config <name> --persona-file`).
The ten cast personas went through three rounds here before going live
(`docs/decisions.md`, 2026-10-12).

A change that rides a pull request can instead edit `personas/` directly and
be tested with `--drafts personas`, since that folder is in the image and
needs no mount (`docs/gizmo-voice-test-4-prompt.md`); the deploy then loads
the files.
