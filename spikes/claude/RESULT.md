# Claude spike: result

Spike for spec 3.2 milestone 0, risk 3 in spec 2.8. Run on 13 Nov 2026 with Claude Code **2.1.323**, the newest release in the public changelog that day. The account is signed in with a claude.ai subscription ("max", plan tier `max_20x`). Model alias `opus` resolved to `claude-opus-5-5`.

**Verdict.** Scripted calls on the subscription work as spec 2.4.6 describes. One extra flag (`--system-prompt-file`), one extra environment setting (`CLAUDE_CODE_MAX_RETRIES`) and a few extra variables to remove are needed. On the synthetic fixtures every planted cut was found, no suggestion was wrong, and every quote was found verbatim. An hour of speech takes 51 to 67 s, which is right at the "under a minute" target in 1.11. Risk 3 is unchanged: the docs still say bare mode will become the `-p` default, and no opt-out is documented.

Model calls used: 5 of the 8 allowed. The signed-out and offline runs never reached the model and reported 0 tokens.

## Files

| Path (under `spikes/claude/`) | What |
| --- | --- |
| `recorded/system-prompt.txt` | **Final system prompt** (v2). `system-prompt.v1.txt` is the first version. |
| `recorded/suggestions.schema.json` | **Answer schema** (spec 3.5.8), passed inline to `--json-schema` |
| `recorded/request-150.txt`, `recorded/request-600.txt` | Example requests (standard input), built by `build_request.py` |
| `recorded/success-150.stdout.txt` | Canonical success envelope: final prompt and final command, 150 utterances |
| `recorded/success-600-v1.stdout.txt`, `success-600-v2-verbose.stdout.txt`, `success-600-v2-effort-low.stdout.txt`, `success-150-v1-verbose.stdout.txt` | The other recorded successes. The `-verbose` files are message arrays, not the plain envelope. |
| `recorded/print-signed-out.stdout.txt` | Print-mode call with an empty config folder |
| `recorded/print-offline.stdout.txt` | Unreachable proxy, default retries (186 s) |
| `recorded/print-offline-retries2.stdout.txt` | Unreachable proxy, `CLAUDE_CODE_MAX_RETRIES=2` (3.7 s) |
| `recorded/auth-status-*.stdout.txt` | `claude auth status` signed in, signed out and offline (`--json` and `--text`), and with an `ANTHROPIC_API_KEY` in the parent. Account fields are redacted. |
| `recorded/*.meta.json` | For each run: argv, the names of removed variables, added variables, exit code, wall-clock seconds |
| `make_transcripts.py` | Generates `data/transcript-{150,600}.json` (spec 3.4 `Transcript` shape) and `data/ground-truth-{150,600}.json` |
| `build_request.py` | Request builder (spec 3.5.8 format) |
| `run_claude.py` | Runs `claude` exactly as below and records the run. Modes: normal, `signed_out`, `offline`. |
| `score.py` | Scores an envelope against the ground truth and checks that each quote can be located |

## 1. Request format (standard input)

```
Transcript to review: 151 utterances.
Each line is tab-separated: utterance number, start time (h:mm:ss.s), pause after the utterance in seconds, text.

1	0:00:02.4	0.5	Hey everyone, welcome back to the weekly Tally update.
2	0:00:06.3	1.1	If you're new here, Tally is ...
```

- "Pause after" is the next utterance's `start` minus this utterance's `end`. The last line gets 0.
- The text is the word tokens joined by single spaces. Pause and unrecognised tokens are left out.
- No other instruction goes on standard input. The whole task is in the system prompt.
- Sizes: 150 utterances (14.5 min) is 12.7 KB; 600 utterances (58 min) is 50.7 KB. The 10 MB standard-input cap is far away.

## 2. The working command

```
claude -p --output-format json --json-schema <schema JSON, one line> --tools "" --system-prompt-file <abs path>/system-prompt.txt --no-session-persistence --setting-sources "" --strict-mcp-config --disable-slash-commands --model opus
```

- Standard input carries the request (UTF-8).
- The working folder is a new, empty temporary folder, deleted afterwards. Nothing was left in it, and no project folder was created under `~/.claude/projects`.
- Pass the arguments as an argv list, never through a shell. `claude.exe` is a native executable at `%USERPROFILE%\.local\bin\claude.exe`, not a `.cmd` shim, so Rust `Command` quoting is safe. The empty string after `--tools` and `--setting-sources` must reach `claude` as a real empty argument.
- `--system-prompt-file` is missing from `claude --help` but is documented in the CLI reference, and it worked. Use it instead of an inline `--system-prompt` so the prompt never hits command-line length or quoting limits.
- `--setting-sources ""` (no sources) is accepted.
- `--disable-slash-commands` keeps skills out.
- No `--bare`, because bare mode never reads the subscription login.
- No `--effort`: the default was kept. See section 5.

**Child environment.** Start from the app's environment, then:

- **Remove** `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_BASE_URL`, `ANTHROPIC_PROFILE`, `ANTHROPIC_FEDERATION_RULE_ID`, `CLAUDE_CODE_USE_BEDROCK`, `CLAUDE_CODE_USE_VERTEX`, `CLAUDE_CODE_USE_FOUNDRY` and `CLAUDE_CODE_SIMPLE`. The last one equals `--bare`.
- **Remove** every other `CLAUDE*` and `ANTHROPIC_*` variable, except `CLAUDE_CONFIG_DIR`. This drops nesting markers such as `CLAUDECODE`, `CLAUDE_CODE_CHILD_SESSION`, `CLAUDE_CODE_SESSION_ID`, `CLAUDE_CODE_ENTRYPOINT` and `CLAUDE_CODE_MESSAGING_*`. These were present in this agent session; real Roughcut will rarely have them, but stripping them is harmless.
- **Set** `ENABLE_CLAUDEAI_MCP_SERVERS=false`, so the claude.ai connectors are not fetched.
- **Set** `CLAUDE_CODE_MAX_RETRIES=2`. With the default of 10 retries, an offline call took **186 s** to fail; with 2 it took **3.7 s**.
- In the app, also kill the child after a time limit (suggested 180 s) and report `claude_offline`.

**Proof that the subscription was used, not an API key:**

- The `--verbose` init message says `"apiKeySource": "none"`.
- `auth status` says `"authMethod": "claude.ai"`.
- With a fake `ANTHROPIC_API_KEY` in the parent and run without stripping, `auth status` reports `"authMethod": "api_key", "apiKeySource": "ANTHROPIC_API_KEY"`. That shows the key really would win. The same parent run through `run_claude.py` reports `claude.ai`.
- The init message also lists `"tools": ["StructuredOutput"]` and `"mcp_servers": []`, with no skills and no slash commands. Built-in agents and built-in plugins are listed, but without the Agent tool they cannot run.
- The `rate_limit_event` shows the subscription's seven-day window (`utilization 0.26`).

## 3. Envelope (stdout, one JSON object; exit code 0 on success)

Top-level keys: `type` ("result"), `subtype`, `is_error`, `result`, `structured_output`, `terminal_reason`, `api_error_status`, `stop_reason`, `num_turns`, `duration_ms`, `duration_api_ms`, `ttft_ms`, `ttft_stream_ms`, `time_to_request_ms`, `first_content_frame_ms`, `total_cost_usd`, `usage`, `modelUsage`, `permission_denials`, `session_id`, `uuid`, `subagent_stats`, `safety_stops`, `fast_mode_state`, `fast_mode_disabled_reason`, `queued_turn_count`, `result_index`, `credential_expires_at`. Error envelopes also carry `api_error`.

- **The answer is in `structured_output`**, an object `{"suggestions":[...]}`. `result` holds the same JSON as a string. Read `structured_output`, and treat a missing one as a bad answer.
- Success values: `is_error: false`, `subtype: "success"`, `terminal_reason: "completed"`, `stop_reason: "tool_use"`, `num_turns: 2`.
- Token usage is in `usage`: `input_tokens`, `cache_creation_input_tokens`, `cache_read_input_tokens`, `output_tokens` and `output_tokens_details.thinking_tokens`.
- `modelUsage["claude-opus-5-5"]` holds the same figures plus `costUSD`, `costBasis: "list"`, `contextWindow` (1,000,000) and `maxOutputTokens` (128,000).
- `total_cost_usd` is a client-side estimate at list price. It is not a charge on the subscription.
- `credential_expires_at` holds the login expiry and could be shown in settings.
- **Warning:** error envelopes also say `subtype: "success"`. Branch on `is_error`, never on `subtype`.
- `--verbose` makes stdout an array of every message (init, thinking, assistant, tool result, `rate_limit_event`, result). It was used only to inspect runs. The app should not use it.

## 4. Error signatures

| App error | Observed? | How to recognise it |
| --- | --- | --- |
| `claude_missing` | n/a | Spawn fails (file not found). Read the version with `claude --version` → `2.1.323 (Claude Code)`. |
| `claude_signed_out` (pre-check) | **observed** | `claude auth status` (JSON is the default) **exits 1** with `{"loggedIn": false, "authMethod": "none", "apiProvider": "firstParty", ..., "loginExpiresAt": null}`. With `--text` it prints `Not logged in. Run claude auth login to authenticate.` When signed in it exits 0 with `"loggedIn": true, "authMethod": "claude.ai", "subscriptionType": "max", "loginExpiresAt": "..."`. Takes about 0.6 to 0.9 s, needs no network (it still said signed in with the unreachable proxy) and makes no model call. |
| `claude_signed_out` (in the call) | **observed** | Exit 1, `is_error: true`, `terminal_reason: "api_error"`, `api_error_status: null`, zero usage, `result: "Not logged in · Please run /login"`. The middle character is U+00B7; decode stdout as UTF-8. Took 1.0 s. The docs add `Login expired · Please run /login` for an expired login. Match on a `result` that starts with `Not logged in` or `Login expired`. |
| `claude_offline` | **observed** | Exit 1, `is_error: true`, `terminal_reason: "api_error"`, **`api_error: "connection_failed"`**, `api_error_status: null`, `result: "API Error: Connection refused — a firewall or proxy may be blocking it (ECONNREFUSED)"`. Other connection texts from the docs (errors page, "Unable to connect to API") are `Unable to connect to API`, `Can't reach the API server`, `No internet route`, `Connection dropped`, `Request timed out` and `API Error: No response from API`. Match on `api_error == "connection_failed"`, then on those prefixes, then on the app's own time limit. |
| `claude_limit` | **not observed** (could not be triggered safely) | From the docs (errors page, "Usage limits"), the texts are `You've hit your session limit · resets 3:45pm`, `You've hit your weekly limit · resets ...`, `You've hit your Opus limit · resets ...`, and the `You've hit your ... spend limit` / `usage limit` variants. Expect exit 1 and `is_error: true`, probably with `api_error_status: 429`; the exact `api_error` value is unknown. Match on `is_error` together with any of: `api_error_status == 429`, `result` matching `/hit your .*limit/i`, or `result` containing `usage limit` or `spend limit`. `API Error: Server is temporarily limiting requests (not your usage limit)` is a short throttle and should count as offline-and-retry, not as a limit. With stream-json, a `rate_limit_event` whose `rate_limit_info.status` is `"rejected"` is a cleaner signal. |
| `claude_bad_answer` | not observed | Exit 0 with no `structured_output` (the docs say this happens when Claude declines). Also: a result `subtype` of `error_max_structured_output_retries` or `error_during_execution`, or `terminal_reason: "structured_output_retry_exhausted"`. Also when stdout does not parse, or the answer fails the app's own schema or range checks. |
| Any other `is_error: true` | | Treat as `claude_bad_answer` and keep `result` as the detail. |

Exit codes seen: 0 on success; 1 for signed out and offline, in print mode and for `auth status` when signed out. The docs say SIGTERM gives 143.

## 5. Measurements (wall clock includes process start)

| Run | Prompt | Utterances | Wall s | API ms | TTFT ms | Input tokens (new + cache write + cache read) | Output tokens (thinking) | Est. cost $ |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| success-150-v1-verbose | v1 | 151 | 26.2 | 24,908 | 8,736 | 2 + 7,614 + 0 | 3,307 (1,010) | 0.127 |
| success-150 | v2 | 151 | **20.5** | 19,203 | 8,428 | 2 + 6,002 + 1,655 | 2,667 (980) | 0.102 |
| success-600-v1 | v1 | 604 | 67.3 | 65,369 | 13,676 | 2 + 22,025 + 1,612 | 9,328 (1,487) | 0.363 |
| success-600-v2-verbose | v2 | 604 | **56.8** | 54,787 | 12,893 | 2 + 22,999 + 682 | 8,042 (1,293) | 0.345 |
| success-600-v2-effort-low | v2, `--effort low` | 604 | 50.9 | 50,108 | 7,900 | 2 + 363 + 23,318 (cache hit) | 7,560 (815) | 0.159 |
| print-signed-out | | | 1.0 | 0 | | 0 | 0 | 0 |
| print-offline (10 retries) | | | 186.0 | 0 | | 0 | 0 | 0 |
| print-offline-retries2 | | | 3.7 | 0 | | 0 | 0 | 0 |

- **Input is larger than spec 2.4.6 assumed.** An hour of speech is about 23,700 input tokens: transcript, system prompt and Claude Code's structured-output tool. Spec 2.4.6 and 2.6 say about 15,000.
- **Output is most of the time.** Over an hour about 6,700 visible output tokens are generated at roughly 190 tokens/s, mostly the `quote` fields. Whole-utterance retakes repeat their full text.
- The effort-low run is faster and cheaper partly because it hit the prompt cache written by the call before it, so it is not a clean comparison. Quality did not change on this fixture. Keep the default effort. Revisit `--effort low` only if real recordings miss the one-minute target.
- **v1 to v2 change.** v1 made Claude write a ~250-word chat summary before the structured output, which is wasted output. v2 adds "give your answer only through the structured output, write no other text" and shortens the `reason` example. The verbose run confirms v2 has no text block, and an hour of speech dropped from 67 s to 57 s.

## 6. Quality against the ground truth

The fixtures are a hand-written weekly update from a solo app developer. `make_transcripts.py` holds the script.

- The 150-utterance fixture has 9 planted retakes (some with 3 takes), 6 false starts and 6 asides. Three of the asides follow a botched take and must also cut that take; three stand alone.
- It also has decoys that must not be cut: deliberate repetition ("Never." / "Not even a little banner."), a self-correcting joke, fillers, and long silences (6.5 s and 5.2 s).
- The 600-utterance fixture is the same show for four different weeks, with the numbers and names changed: 84 planted items.

| Run | Found | Missed | Wrong | Kind correct | Quote located verbatim | keep_utterance correct | Mean extent overlap (IoU) |
| --- | --- | --- | --- | --- | --- | --- | --- |
| success-150-v1-verbose | 21/21 | 0 | 0 | 21/21 | 21/21 | 12/12 | 0.989 |
| success-150 (v2) | 21/21 | 0 | 0 | 21/21 | 21/21 | 12/12 | 0.989 |
| success-600-v1 | 84/84 | 0 | 0 | 84/84 | 84/84 | 48/48 | 0.984 |
| success-600-v2-verbose | 84/84 | 0 | 0 | 84/84 | 84/84 | 48/48 | 0.995 |
| success-600-v2-effort-low | 84/84 | 0 | 0 | 84/84 | 84/84 | 48/48 | 0.990 |

**Extent differences.**
- On two false starts Claude leaves a leading "And" in place ("And ~~I want to be, I want to be~~ I want to be clear..."). That reads fine.
- Once in v1 it took one extra repeated "the" ("...is that the the reason..."), which would cut the restart's first word. v2 did this less often (80 of 84 exact).

**Other observations.**
- No decoy and no silence was ever suggested.
- Claude never let suggestions span weeks in the repeated hour-long fixture.
- The prompt did not need a quality fix, so the one allowed revision went into speed (v2 above).

**Caveat.** These fixtures are clean, planted and written by hand. Real Parakeet output from a real recording will be messier. Spec 3.7 plans a check by eye on the two-minute speech fixture, and that is still needed.

## 7. Risk 3: bare mode becoming the `-p` default

- **Installed help (2.1.323).** `--bare` is described as minimal mode in which "Anthropic auth is strictly ANTHROPIC_API_KEY or apiKeyHelper via --settings (OAuth and keychain are never read)". The help does **not** mention it becoming the default and lists no opt-out flag.
- **Docs today.** The headless page, "Start faster with bare mode", still says: "`--bare` is the recommended mode for scripted and SDK calls, and will become the default for `-p` in a future release."
- **No opt-out.** No opt-out is documented: no `--no-bare` and no variable for it. I grepped the CLI reference, the env-vars page, the headless page and the full changelog. `CLAUDE_CODE_SIMPLE` only turns bare mode **on**.
- **Changelog.** Up to 2.1.323 it contains no entry that makes bare the default. It only narrows what `--bare` loads.
- **Recommendation.** Keep the spec's mitigation. Record `claudeCodeVersionTested = "2.1.323"`, and on a version change show the "changed" warning. Also run the call once and treat a `Not logged in` result while `auth status` says `loggedIn: true` as the bare-default signature, and show it as such. The API-key setting remains the fallback.
- **Manual per-release check.** Run the fixed command once with `--verbose` added. The init message's `apiKeySource` field, and whether the call authenticates at all, show whether bare mode has become the default.

## 8. Things Part 2 and Part 3 should take from this

1. **Add to 2.4.6 and the child-process tests (3.7):** `--system-prompt-file`, `--setting-sources ""`, `--strict-mcp-config`, `--disable-slash-commands`, `ENABLE_CLAUDEAI_MCP_SERVERS=false`, `CLAUDE_CODE_MAX_RETRIES=2`, the time limit, and the wider list of variables to remove.
2. **Update the 2.4.6 and 2.6 token estimate:** about 24k input tokens per hour, not 15k. An hour takes about 1 minute, about 20 s for 15 minutes.
3. **The stand-in `claude` for 3.7 tests** can replay the files in `recorded/` directly:
   - success: `success-150.stdout.txt` with exit 0
   - signed out: `print-signed-out.stdout.txt` with exit 1, and `auth-status-signed-out.json.stdout.txt` with exit 1
   - offline: `print-offline-retries2.stdout.txt` with exit 1
   - The limit case must be synthesised from section 4 and marked as not observed.
4. **Read stdout as UTF-8.** Error texts contain `·` and `—`.
