Synthesised envelopes for the stand-in `claude` (not recorded from the real program).

- `limit.stdout.txt`: usage limit. NOT OBSERVED in the experiment (it could not be triggered
  safely); built from spikes/claude/RESULT.md section 4: `is_error: true`,
  `api_error_status: 429`, result text from the Claude Code errors page.
- `no-structured-output.stdout.txt`: exit 0, `is_error: false`, no `structured_output`
  (the docs' "Claude declines" case).
- `schema-violation.stdout.txt`: a `structured_output` with a kind outside the schema.
- `garbage.stdout.txt`: standard output that is not JSON.
