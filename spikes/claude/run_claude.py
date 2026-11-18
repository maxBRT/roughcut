"""Run `claude -p` the way the app will (spec 2.4.6) and record everything.

Usage:
  python run_claude.py call <request.txt> <name> [--mode normal|signed_out|offline] [--verbose]
  python run_claude.py auth <name> [--mode normal|signed_out]

Writes recorded/<name>.stdout.txt, recorded/<name>.stderr.txt and recorded/<name>.meta.json
(command line, removed env var NAMES only, exit code, wall-clock seconds).
Never prints or stores credentials. Personal account fields in `auth status`
output are redacted before saving.
"""
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
REC = HERE / "recorded"
SYSTEM_PROMPT = REC / "system-prompt.txt"
SCHEMA = REC / "suggestions.schema.json"

# Variables that would change which credential or mode the child uses, or that mark
# it as nested inside this Claude Code session. Removed from the child only.
DROP_EXACT = {
    "ANTHROPIC_API_KEY",           # would be preferred over the subscription in -p
    "ANTHROPIC_AUTH_TOKEN",        # bearer token, also outranks the subscription
    "ANTHROPIC_BASE_URL",          # a stale gateway would break or reroute the call
    "ANTHROPIC_PROFILE",
    "ANTHROPIC_FEDERATION_RULE_ID",
    "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_USE_FOUNDRY",
    "CLAUDE_CODE_SIMPLE",          # = --bare, which ignores the subscription login
}
KEEP_PREFIXED = {"CLAUDE_CONFIG_DIR"}
RETRIES = None  # set by --retries N  # the user's own choice of config folder is respected


def child_env(mode):
    env = {}
    removed = []
    for k, v in os.environ.items():
        ku = k.upper()
        if ku in DROP_EXACT or (
            (ku.startswith("CLAUDE") or ku.startswith("ANTHROPIC_")) and ku not in KEEP_PREFIXED
        ):
            removed.append(k)
            continue
        env[k] = v
    env["ENABLE_CLAUDEAI_MCP_SERVERS"] = "false"  # no claude.ai connectors in the child
    if RETRIES is not None:
        env["CLAUDE_CODE_MAX_RETRIES"] = RETRIES  # default 10 retries => ~3 min to fail offline
    if mode == "signed_out":
        empty = tempfile.mkdtemp(prefix="roughcut-claude-empty-config-")
        env["CLAUDE_CONFIG_DIR"] = empty
    if mode == "offline":
        # Unreachable proxy for the child only: nothing listens on port 9 locally.
        for k in ("HTTPS_PROXY", "HTTP_PROXY", "https_proxy", "http_proxy"):
            env[k] = "http://127.0.0.1:9"
        env.pop("NO_PROXY", None)
        env.pop("no_proxy", None)
    return env, sorted(removed)


def claude_exe():
    exe = shutil.which("claude")
    if not exe:
        sys.exit("claude not on PATH")
    return exe


def command(verbose=False, model="opus"):
    schema = json.dumps(json.loads(SCHEMA.read_text(encoding="utf-8")), separators=(",", ":"))
    cmd = [
        claude_exe(), "-p",
        "--output-format", "json",
        "--json-schema", schema,
        "--tools", "",
        "--system-prompt-file", str(SYSTEM_PROMPT),
        "--no-session-persistence",
        "--setting-sources", "",
        "--strict-mcp-config",
        "--disable-slash-commands",
        "--model", model,
    ]
    if EFFORT:
        cmd += ["--effort", EFFORT]
    if verbose:
        cmd.append("--verbose")
    return cmd


EFFORT = os.environ.get("SPIKE_EFFORT")  # experiment only: SPIKE_EFFORT=low


def redact(text):
    try:
        data = json.loads(text)
    except Exception:
        out = []
        for line in text.splitlines():
            if line.startswith(("Email:", "Organization:")):
                line = line.split(":", 1)[0] + ": <redacted>"
            out.append(line)
        return "\n".join(out) + ("\n" if text.endswith("\n") else "")
    for key in ("email", "orgId", "orgName", "projectsDirectory", "configDirectory"):
        if key in data and data[key]:
            data[key] = "<redacted>"
    return json.dumps(data, indent=2) + "\n"


def run(cmd, stdin_text, mode, name, redact_out=False, timeout=600):
    env, removed = child_env(mode)
    cwd = tempfile.mkdtemp(prefix="roughcut-claude-cwd-")
    t0 = time.perf_counter()
    try:
        p = subprocess.run(cmd, input=stdin_text.encode("utf-8") if stdin_text is not None else None,
                           stdin=None if stdin_text is not None else subprocess.DEVNULL,
                           capture_output=True, env=env, cwd=cwd, timeout=timeout)
        code, out, err = p.returncode, p.stdout.decode("utf-8", "replace"), p.stderr.decode("utf-8", "replace")
    except subprocess.TimeoutExpired as e:
        code, out, err = "timeout", (e.stdout or b"").decode("utf-8", "replace"), (e.stderr or b"").decode("utf-8", "replace")
    wall = time.perf_counter() - t0
    leftovers = os.listdir(cwd)
    shutil.rmtree(cwd, ignore_errors=True)
    if mode == "signed_out":
        shutil.rmtree(env["CLAUDE_CONFIG_DIR"], ignore_errors=True)
    if redact_out:
        out, err = redact(out), redact(err)
    REC.mkdir(exist_ok=True)
    (REC / f"{name}.stdout.txt").write_text(out, encoding="utf-8", newline="\n")
    (REC / f"{name}.stderr.txt").write_text(err, encoding="utf-8", newline="\n")
    shown = [("<schema json>" if i > 0 and cmd[i - 1] == "--json-schema" else
              "<path>/recorded/system-prompt.txt" if i > 0 and cmd[i - 1] == "--system-prompt-file" else
              "claude" if i == 0 else a) for i, a in enumerate(cmd)]
    meta = dict(name=name, mode=mode, argv=shown, removed_env_names=removed,
                added_env=["ENABLE_CLAUDEAI_MCP_SERVERS=false"]
                + ([f"CLAUDE_CODE_MAX_RETRIES={RETRIES}"] if RETRIES is not None else [])
                + (["CLAUDE_CONFIG_DIR=<new empty temp folder>"] if mode == "signed_out" else [])
                + (["HTTPS_PROXY=HTTP_PROXY=http://127.0.0.1:9"] if mode == "offline" else []),
                stdin_bytes=len(stdin_text.encode("utf-8")) if stdin_text else 0,
                exit_code=code, wall_seconds=round(wall, 2), files_left_in_cwd=leftovers)
    (REC / f"{name}.meta.json").write_text(json.dumps(meta, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(meta, indent=2))
    print("--- stdout (first 3000 chars) ---")
    print(out[:3000])
    print("--- stderr (first 2000 chars) ---")
    print(err[:2000])


def main():
    args = sys.argv[1:]
    mode = "normal"
    if "--mode" in args:
        i = args.index("--mode")
        mode = args[i + 1]
        del args[i:i + 2]
    global RETRIES
    if "--retries" in args:
        i = args.index("--retries")
        RETRIES = args[i + 1]
        del args[i:i + 2]
    verbose = "--verbose" in args
    if verbose:
        args.remove("--verbose")
    if args[0] == "call":
        req = Path(args[1]).read_text(encoding="utf-8")
        run(command(verbose), req, mode, args[2], timeout=900)
    elif args[0] == "auth":
        fmt = args[2] if len(args) > 2 else "--json"
        run([claude_exe(), "auth", "status", fmt], None, mode, args[1], redact_out=True, timeout=60)
    else:
        sys.exit(__doc__)


if __name__ == "__main__":
    main()
