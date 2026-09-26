@AGENTS.md

## Claude Code substitutions

`AGENTS.md` and the workflow skills in `.agents/skills/` (linked as
`.claude/skills/`) name Codex roles and invocations. In Claude Code, read them
with these substitutions; every other rule applies unchanged.

- The Claude Code main session is the primary/root session and task owner.
- `$issue`, `$plan`, `$impl`, and `$release` are the `/issue`, `/plan`, `/impl`,
  and `/release` skills.
- `researcher` is the built-in `Explore` subagent.
- `reviewer` is `/code-review` on the current diff (the staged release diff for
  `/release`), plus `/security-review` when the change carries security risk. The
  main session verifies each finding and allows at most one focused re-review.
- `worker` is a `general-purpose` subagent whose prompt names the exclusive paths,
  transformation, acceptance criteria, and validation commands. The main session
  does not modify repository or external state while it runs.
- `.codex/agents/*.toml` settings (`model`, `model_reasoning_effort`,
  `sandbox_mode`) have no Claude Code equivalent; read-only roles use read-only
  subagent types.
