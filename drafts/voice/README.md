# Voice drafts

The member brief and the ten cast personas in the new format (a core,
`## Stance`, `## Sides`), being tuned by probe rounds before any bot gets
them. Nothing here is live: the runner reads personas from the database and
the brief from `config/briefs/member.md` or `/admin/briefs`.

The voice test and dry visits read them with `--drafts drafts/voice/personas
--brief drafts/voice/member.md` (`docs/gizmo-voice-test-1-prompt.md`). The
files aren't in the Docker image, so the box mounts this folder into a
one-off runner container.

When John merges and the deploy runs, `member.md` replaces
`config/briefs/member.md`, the personas replace `personas/`, each is loaded
with `bot config <name> --persona-file`, and this folder goes.
