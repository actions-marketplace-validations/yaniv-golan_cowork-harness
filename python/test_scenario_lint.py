"""Tests for the bundled linter (scenario.py): its assertion-key list is generated from the Zod schema
(no drift), and its replay-class warnings account for manifest-backed assertions.

Run via the repo's pytest lane: `pytest -m 'not cowork'` from python/.
"""
import contextlib
import importlib.util
import io
import json
import types as _types
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[1]
SCENARIO_PY = REPO / ".claude/skills/cowork-harness/scripts/scenario.py"
KEYS_JSON = REPO / ".claude/skills/cowork-harness/scripts/assertion-keys.json"


def _load_scenario_module():
    spec = importlib.util.spec_from_file_location("scenario_lint_under_test", SCENARIO_PY)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


scenario = _load_scenario_module()


def _rules(yaml_body, tmp_path):
    f = tmp_path / "sc.yaml"
    f.write_text(
        "name: t\nbaseline: latest\nsession: (inline)\nfidelity: container\nprompt: hi\n" + yaml_body,
        encoding="utf-8",
    )
    return {fnd.rule for fnd in scenario.lint_file(str(f))}


def test_assert_keys_loaded_from_generated_file():
    generated = set(json.loads(KEYS_JSON.read_text(encoding="utf-8"))["keys"])
    assert scenario.ASSERT_KEYS == generated
    # the two keys that used to drift are present
    assert {"artifact_json", "allow_permissive_auto_allow"} <= scenario.ASSERT_KEYS


def test_embedded_fallback_equals_generated_list():
    # the in-code fallback must equal the generated list, else a missing file silently reintroduces drift
    generated = set(json.loads(KEYS_JSON.read_text(encoding="utf-8"))["keys"])
    assert scenario._CLASSIFIED_KEYS == generated


def test_every_key_is_classified_self_check():
    assert scenario.UNCLASSIFIED_KEYS == []


def test_artifact_json_is_not_unknown(tmp_path):
    rules = _rules("assert:\n  - artifact_json: {artifact: outputs/x.json, path: a, equals: 1}\n", tmp_path)
    assert "unknown-assert-key" not in rules
    assert "manifest-needs-snapshot" in rules  # it IS manifest-backed on replay


def test_allow_permissive_auto_allow_is_not_unknown(tmp_path):
    rules = _rules("assert:\n  - allow_permissive_auto_allow: true\n", tmp_path)
    assert "unknown-assert-key" not in rules


def test_file_exists_only_is_not_replay_noop(tmp_path):
    rules = _rules("assert:\n  - file_exists: outputs/x.md\n", tmp_path)
    assert "replay-noop" not in rules  # manifest-backed → replay-checkable with a manifest
    assert "manifest-needs-snapshot" in rules


def test_egress_only_is_replay_noop(tmp_path):
    rules = _rules("assert:\n  - egress_denied: evil.com\n", tmp_path)
    assert "replay-noop" in rules  # truly live-only → skipped on replay


def test_invented_key_still_flagged(tmp_path):
    rules = _rules("assert:\n  - file_not_empty: outputs/x\n", tmp_path)
    assert "unknown-assert-key" in rules


# --- verdict-modifier single-source parity + replay-class behavior (Step 7) ---


def _findings(yaml_body, tmp_path):
    f = tmp_path / "sc.yaml"
    f.write_text(
        "name: t\nbaseline: latest\nsession: (inline)\nfidelity: container\nprompt: hi\n" + yaml_body,
        encoding="utf-8",
    )
    return scenario.lint_file(str(f))


def test_verdict_modifier_keys_parity_with_generated():
    # the hardcoded Python set must equal the generated subset (TS VERDICT_MODIFIER_KEYS is authoritative).
    # NB: JSON value is an array, the Python value is a set — wrap in set(), like the keys parity above.
    generated = set(json.loads(KEYS_JSON.read_text(encoding="utf-8"))["verdictModifierKeys"])
    assert scenario.VERDICT_MODIFIER_KEYS == generated


def test_modifier_only_scenario_is_replay_noop(tmp_path):
    # a standalone verdict modifier verifies nothing on the replay lane (it's a no-op pass), so it SHOULD
    # still trip replay-noop — modifiers are deliberately NOT in CONTENT_KEYS.
    for mod in scenario.VERDICT_MODIFIER_KEYS:
        rules = _rules(f"assert:\n  - {mod}: true\n", tmp_path)
        assert "replay-noop" in rules, mod


def test_replay_noop_message_names_verdict_modifiers(tmp_path):
    # guards the broadened warning text against a silent revert (a rule-fires test alone wouldn't catch it).
    findings = _findings("assert:\n  - allow_l0_plugin_divergence: true\n", tmp_path)
    msg = next(f.message for f in findings if f.rule == "replay-noop")
    assert "verdict modifier" in msg


def test_content_plus_modifier_item_is_not_mixed(tmp_path):
    # {result, allow_x} is NOT a mixed-class item — a modifier isn't a dropped live-only half, and `result`
    # makes the set replay-checkable, so neither mixed-assert-item nor replay-noop should fire.
    rules = _rules("assert:\n  - {result: success, allow_missing_capability: true}\n", tmp_path)
    assert "mixed-assert-item" not in rules
    assert "replay-noop" not in rules


# --- lint accepts a directory (mirrors resolveInputs: combined sort, empty dir = loud error) ---


def _lint_cmd(files, json_out=True, strict=False):
    args = _types.SimpleNamespace(files=[str(x) for x in files], json=json_out, strict=strict)
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        code = scenario.cmd_lint(args)
    out = buf.getvalue()
    return code, (json.loads(out) if json_out else out)


def _write_scenario(path, body="assert:\n  - egress_denied: a.com\n"):
    path.write_text(
        "name: t\nbaseline: latest\nsession: (inline)\nfidelity: container\nprompt: hi\n" + body,
        encoding="utf-8",
    )


def test_lint_accepts_a_directory(tmp_path):
    # both *.yaml and *.yml under the dir are expanded + linted (2 distinct replay-noop findings prove it).
    _write_scenario(tmp_path / "a.yaml", body="assert:\n  - egress_denied: a.com\n")
    _write_scenario(tmp_path / "b.yml", body="assert:\n  - egress_denied: b.com\n")
    code, findings = _lint_cmd([tmp_path], json_out=True)
    files = {f["file"] for f in findings if f["rule"] == "replay-noop"}
    assert len(files) == 2


def test_lint_empty_directory_is_loud_error(tmp_path):
    code, findings = _lint_cmd([tmp_path], json_out=True)
    assert code == 1
    assert any(f["rule"] == "no-scenarios" for f in findings)


def test_lint_single_file_still_works(tmp_path):
    f = tmp_path / "one.yaml"
    _write_scenario(f, body="assert:\n  - result: success\n")
    code, out = _lint_cmd([f], json_out=False)
    assert code == 0


def test_positional_choose_emits_order_advisory(tmp_path):
    # H1: a positional `choose` (index or `first`) is order-dependent → INFO advisory.
    idx = _rules('answers:\n  - when_question: ".*"\n    choose: "2"\n', tmp_path)
    assert "positional-choose-order" in idx
    first = _rules('answers:\n  - when_question: ".*"\n    choose: first\n', tmp_path)
    assert "positional-choose-order" in first


def test_label_choose_no_order_advisory(tmp_path):
    # by-label is reproducible → no advisory.
    rules = _rules('answers:\n  - when_question: ".*"\n    choose: "Markdown"\n', tmp_path)
    assert "positional-choose-order" not in rules


# --- regex-quoting: odd vs even backslash runs (a correctly-escaped "\\d" is NOT a mistake) ---


def test_double_quoted_odd_backslash_is_flagged(tmp_path):
    # a single backslash in a double-quoted regex is a real footgun — YAML eats/mangles it.
    rules = _rules('assert:\n  - transcript_matches: "\\d+ items"\n', tmp_path)
    assert "regex-double-quoted" in rules


def test_double_quoted_even_backslash_is_not_flagged(tmp_path):
    # "\\d+ items" is a CORRECTLY double-quote-escaped regex (YAML decodes it to `\d+ items`) — the
    # linter must not false-positive on properly paired backslashes.
    rules = _rules('assert:\n  - transcript_matches: "\\\\d+ items"\n', tmp_path)
    assert "regex-double-quoted" not in rules


def test_single_quoted_regex_never_flagged(tmp_path):
    rules = _rules("assert:\n  - transcript_matches: '\\d+ items'\n", tmp_path)
    assert "regex-double-quoted" not in rules


# --- fidelity/assert compatibility rules ---


def _rules_at(tier, yaml_body, tmp_path):
    """Like _rules but with an explicit fidelity tier."""
    f = tmp_path / "sc.yaml"
    f.write_text(
        "name: t\nbaseline: latest\nsession: (inline)\n"
        f"fidelity: {tier}\nprompt: hi\n" + yaml_body,
        encoding="utf-8",
    )
    return {fnd.rule for fnd in scenario.lint_file(str(f))}


def test_host_path_assert_on_hostloop_is_error(tmp_path):
    body = "assert:\n  - transcript_no_host_path: true\n"
    assert "host-path-assert-tier" in _rules_at("hostloop", body, tmp_path)
    assert "host-path-assert-tier" in _rules_at("protocol", body, tmp_path)


def test_host_path_assert_on_container_is_clean(tmp_path):
    body = "assert:\n  - transcript_no_host_path: true\n"
    rules = _rules_at("container", body, tmp_path)
    assert "host-path-assert-tier" not in rules
    assert "host-path-assert-cowork" not in rules


def test_host_path_assert_on_cowork_is_warn_naming_the_gate(tmp_path):
    f = tmp_path / "sc.yaml"
    f.write_text(
        "name: t\nbaseline: latest\nsession: (inline)\nfidelity: cowork\n"
        "prompt: hi\nassert:\n  - transcript_no_host_path: true\n",
        encoding="utf-8",
    )
    findings = scenario.lint_file(str(f))
    hit = [x for x in findings if x.rule == "host-path-assert-cowork"]
    assert len(hit) == 1
    assert hit[0].severity == "WARN"
    # offline gate fact: the message carries the gate id instead of reading a baseline
    assert scenario.HOST_LOOP_GATE_ID in hit[0].message


def test_requires_capabilities_on_protocol_is_error(tmp_path):
    rules = _rules_at(
        "protocol", "requires_capabilities: [ocr]\nassert:\n  - result: success\n", tmp_path
    )
    assert "capabilities-on-protocol" in rules


def test_requires_capabilities_on_protocol_with_optout_is_clean(tmp_path):
    body = (
        "requires_capabilities: [ocr]\n"
        "assert:\n  - {result: success, allow_missing_capability: true}\n"
    )
    assert "capabilities-on-protocol" not in _rules_at("protocol", body, tmp_path)


def test_requires_capabilities_on_container_is_clean(tmp_path):
    rules = _rules_at(
        "container", "requires_capabilities: [ocr]\nassert:\n  - result: success\n", tmp_path
    )
    assert "capabilities-on-protocol" not in rules


def test_empty_requires_capabilities_on_protocol_is_clean(tmp_path):
    rules = _rules_at(
        "protocol", "requires_capabilities: []\nassert:\n  - result: success\n", tmp_path
    )
    assert "capabilities-on-protocol" not in rules


# --- present_files tier keys off their serving tiers -------------------------------------------------
# The two keys are deliberately NOT the same tier class:
#   no_scratchpad_leak  -- container-only ON THE MERITS. Production's host-loop branch validates a path
#                          and passes it through WITHOUT promoting, so at hostloop there is no
#                          scratch->outputs copy that could ever leak.
#   present_files_called -- asserts the harness-side DELIVERY RECORD, served at container AND hostloop
#                          (src/assert.ts: `!== "container" && !== "hostloop"`). Only protocol and
#                          microvm deterministically cannot serve it.
# `fidelity: cowork` resolves to hostloop|container ONLY (src/run/execute.ts), so present_files_called
# is clean there -- no advisory, per AGENTS.md "Advisory design".

SCRATCHPAD_ERROR_TIERS = ("protocol", "microvm", "hostloop")
PRESENT_FILES_ERROR_TIERS = ("protocol", "microvm")


@pytest.mark.parametrize("tier", SCRATCHPAD_ERROR_TIERS)
def test_no_scratchpad_leak_off_container_is_error(tier, tmp_path):
    body = "assert:\n  - no_scratchpad_leak: true\n"
    findings = [
        f
        for f in scenario.lint_file(str(_write_at(tmp_path, tier, body)))
        if f.rule == "container-only-key-off-container"
    ]
    assert len(findings) == 1, tier
    assert findings[0].severity == "ERROR"
    assert "no_scratchpad_leak" in findings[0].message
    assert tier in findings[0].message


@pytest.mark.parametrize("tier", PRESENT_FILES_ERROR_TIERS)
def test_present_files_called_off_serving_tiers_is_error(tier, tmp_path):
    body = "assert:\n  - present_files_called: true\n"
    findings = [
        f for f in scenario.lint_file(str(_write_at(tmp_path, tier, body))) if f.rule == "present-files-key-off-tier"
    ]
    assert len(findings) == 1, tier
    assert findings[0].severity == "ERROR"
    assert "present_files_called" in findings[0].message
    assert tier in findings[0].message


@pytest.mark.parametrize("tier", ("container", "hostloop", "cowork", None))
def test_present_files_called_on_serving_tiers_is_clean(tier, tmp_path):
    """The regression this task exists for: the runtime accepts hostloop, so the linter must not flag it.
    `cowork` resolves to hostloop|container -- both serve the tool -- so it is clean too. `None` =
    omitted fidelity, which defaults to container."""
    body = "assert:\n  - present_files_called: true\n"
    if tier is None:
        f = tmp_path / "sc.yaml"
        f.write_text("name: t\nbaseline: latest\nsession: (inline)\nprompt: hi\n" + body, encoding="utf-8")
        findings = scenario.lint_file(str(f))
    else:
        findings = scenario.lint_file(str(_write_at(tmp_path, tier, body)))
    assert not any(f.rule in ("present-files-key-off-tier", "container-only-key-off-container") for f in findings)


def test_no_scratchpad_leak_on_hostloop_still_errors(tmp_path):
    """Mutation guard: a fix that lifted BOTH keys would green the test above and be wrong."""
    body = "assert:\n  - no_scratchpad_leak: true\n"
    findings = [
        f
        for f in scenario.lint_file(str(_write_at(tmp_path, "hostloop", body)))
        if f.rule == "container-only-key-off-container"
    ]
    assert len(findings) == 1


def test_no_scratchpad_leak_on_cowork_is_warn_naming_the_gate_dependency(tmp_path):
    body = "assert:\n  - no_scratchpad_leak: true\n"
    findings = [
        f
        for f in scenario.lint_file(str(_write_at(tmp_path, "cowork", body)))
        if f.rule == "container-only-key-off-container"
    ]
    assert len(findings) == 1
    assert findings[0].severity == "WARN"
    assert "no_scratchpad_leak" in findings[0].message
    # offline gate fact: the message names the gate-resolution dependency (mirrors host-path-assert-cowork)
    assert scenario.HOST_LOOP_GATE_ID in findings[0].message


@pytest.mark.parametrize("tier", ("container", None))
def test_no_scratchpad_leak_on_container_or_omitted_is_clean(tier, tmp_path):
    body = "assert:\n  - no_scratchpad_leak: true\n"
    if tier is None:
        f = tmp_path / "sc.yaml"
        f.write_text("name: t\nbaseline: latest\nsession: (inline)\nprompt: hi\n" + body, encoding="utf-8")
        findings = scenario.lint_file(str(f))
    else:
        findings = scenario.lint_file(str(_write_at(tmp_path, tier, body)))
    assert not any(f.rule == "container-only-key-off-container" for f in findings)


def _write_at(tmp_path, tier, yaml_body, name="sc.yaml"):
    f = tmp_path / name
    f.write_text(
        "name: t\nbaseline: latest\nsession: (inline)\n"
        f"fidelity: {tier}\nprompt: hi\n" + yaml_body,
        encoding="utf-8",
    )
    return f


def _write_lane(tmp_path, lane, yaml_body, tier="container", name="sc.yaml"):
    f = tmp_path / name
    f.write_text(
        "name: t\nbaseline: latest\nsession: (inline)\n"
        f"fidelity: {tier}\nlane: {lane}\nprompt: hi\n" + yaml_body,
        encoding="utf-8",
    )
    return f


# The runtime (src/run/execute.ts) throws at scenario LOAD time for these three keys on `lane: remote`.
# The linter must catch it offline, before a paid run.
LANE_REMOTE_KEYS = ("present_files_called", "no_scratchpad_leak", "user_visible_artifact")


@pytest.mark.parametrize("key", LANE_REMOTE_KEYS)
def test_lane_remote_incompatible_key_is_error(key, tmp_path):
    value = "outputs/x.md" if key == "user_visible_artifact" else "true"
    body = f"assert:\n  - {key}: {value}\n"
    findings = [f for f in scenario.lint_file(str(_write_lane(tmp_path, "remote", body))) if f.rule == "lane-remote-incompatible-key"]
    assert len(findings) == 1, key
    assert findings[0].severity == "ERROR"
    assert key in findings[0].message
    assert "lane: local" in findings[0].fix or "lane: local" in findings[0].message


@pytest.mark.parametrize("key", LANE_REMOTE_KEYS)
@pytest.mark.parametrize("lane", ("local", None))
def test_lane_local_or_omitted_is_clean(key, lane, tmp_path):
    """`local` is the default; neither it nor an omitted lane may trip the rule."""
    value = "outputs/x.md" if key == "user_visible_artifact" else "true"
    body = f"assert:\n  - {key}: {value}\n"
    f = _write_lane(tmp_path, lane, body) if lane else _write_at(tmp_path, "container", body)
    assert not any(x.rule == "lane-remote-incompatible-key" for x in scenario.lint_file(str(f)))


def test_lane_remote_suppresses_the_tier_rule(tmp_path):
    """`present_files_called` on `lane: remote` + `fidelity: protocol` must report ONLY the lane
    finding. The tier advice ('use container or hostloop') is unreachable -- the lane rejection fires
    first, at load, regardless of tier."""
    body = "assert:\n  - present_files_called: true\n"
    rules = {f.rule for f in scenario.lint_file(str(_write_lane(tmp_path, "remote", body, tier="protocol")))}
    assert "lane-remote-incompatible-key" in rules
    assert "present-files-key-off-tier" not in rules


def test_lane_remote_still_flags_tier_rule_when_lane_is_local(tmp_path):
    """Mutation guard: a suppression that fired unconditionally would green the test above and be wrong."""
    body = "assert:\n  - present_files_called: true\n"
    rules = {f.rule for f in scenario.lint_file(str(_write_lane(tmp_path, "local", body, tier="protocol")))}
    assert "present-files-key-off-tier" in rules


def test_lane_remote_key_error_gates_without_strict(tmp_path):
    f = _write_lane(tmp_path, "remote", "assert:\n  - user_visible_artifact: outputs/x.md\n")
    code, findings = _lint_cmd([f], json_out=True, strict=False)
    assert code != 0
    assert any(x["rule"] == "lane-remote-incompatible-key" and x["severity"] == "ERROR" for x in findings)


def test_tier_keys_are_a_subset_of_the_lane_incompatible_keys():
    """THE invariant that makes whole-block tier suppression safe (Step 4).

    Suppressing the tier blocks wholesale on `lane: remote` is only correct because every key those
    blocks can flag is ALSO lane-rejected -- so the author still gets an ERROR naming that key, just a
    more fundamental one. If a key is ever added to a tier set WITHOUT being lane-rejected, the
    `if lane != "remote"` guard would silently swallow a REACHABLE tier finding, and no other test here
    would notice (they all exercise `present_files_called`). Pin the invariant, not the instance."""
    tier_keys = scenario.CONTAINER_ONLY_KEYS | scenario.CONTAINER_HOSTLOOP_KEYS
    assert tier_keys <= scenario.LANE_REMOTE_INCOMPATIBLE_KEYS, (
        f"{sorted(tier_keys - scenario.LANE_REMOTE_INCOMPATIBLE_KEYS)} can be flagged by a tier rule but "
        "is not lane-rejected -- whole-block suppression in lint_file would hide a reachable finding. "
        "Either add the key to LANE_REMOTE_INCOMPATIBLE_KEYS, or make the suppression per-key."
    )


def test_lane_remote_suppresses_manifest_needs_snapshot_for_the_lane_rejected_key(tmp_path):
    """`user_visible_artifact` on `lane: remote` gets `lane-remote-incompatible-key` (ERROR, load-time
    rejection) -- the `manifest-needs-snapshot` INFO's "re-record so this evaluates" advice is
    unreachable for this key: it can never reach a replay to re-record for. Same rationale as the
    tier-rule suppression above."""
    body = "assert:\n  - user_visible_artifact: outputs/x.md\n"
    rules = {f.rule for f in scenario.lint_file(str(_write_lane(tmp_path, "remote", body)))}
    assert "lane-remote-incompatible-key" in rules
    assert "manifest-needs-snapshot" not in rules


def test_lane_remote_still_flags_manifest_needs_snapshot_for_other_manifest_keys(tmp_path):
    """Mutation guard: `file_exists` is manifest-backed but NOT lane-rejected (only
    `user_visible_artifact` overlaps `LANE_REMOTE_INCOMPATIBLE_KEYS` within `MANIFEST_KEYS`), so it stays
    genuinely reachable on `lane: remote` and the advisory must still fire -- a blanket per-lane
    suppression (instead of the per-key filter) would wrongly swallow this one too."""
    body = "assert:\n  - file_exists: outputs/x.md\n"
    rules = {f.rule for f in scenario.lint_file(str(_write_lane(tmp_path, "remote", body)))}
    assert "lane-remote-incompatible-key" not in rules
    assert "manifest-needs-snapshot" in rules


def test_present_files_key_error_gates_without_strict(tmp_path):
    # ERROR always gates -- nonzero exit even without --strict (mirrors host-path-assert-tier's exit class).
    f = _write_at(tmp_path, "protocol", "assert:\n  - present_files_called: true\n")
    code, findings = _lint_cmd([f], json_out=True, strict=False)
    assert code != 0
    assert any(x["rule"] == "present-files-key-off-tier" and x["severity"] == "ERROR" for x in findings)


def test_container_only_key_warn_gates_only_under_strict(tmp_path):
    # WARN (no_scratchpad_leak on cowork) is zero-exit without --strict, nonzero with --strict.
    f = _write_at(tmp_path, "cowork", "assert:\n  - no_scratchpad_leak: true\n")
    code_plain, findings_plain = _lint_cmd([f], json_out=True, strict=False)
    assert code_plain == 0
    assert any(x["rule"] == "container-only-key-off-container" and x["severity"] == "WARN" for x in findings_plain)

    code_strict, _ = _lint_cmd([f], json_out=True, strict=True)
    assert code_strict != 0


def test_container_only_key_error_gates_without_strict(tmp_path):
    # ERROR (no_scratchpad_leak on protocol) is nonzero-exit even without --strict (mirrors
    # present-files-key-off-tier's exit class -- the WARN test above only covers the cowork/gated case).
    f = _write_at(tmp_path, "protocol", "assert:\n  - no_scratchpad_leak: true\n")
    code, findings = _lint_cmd([f], json_out=True, strict=False)
    assert code != 0
    assert any(x["rule"] == "container-only-key-off-container" and x["severity"] == "ERROR" for x in findings)


# --- lint --min-severity (1.11.0) -------------------------------------------------------------------
def _lint_cli(tmp_path, *flags, body="assert:\n  - file_exists: outputs/x.json\n"):
    """Drive cmd_lint through its real argparse path and capture (exit_code, stdout)."""
    f = tmp_path / "sc.yaml"
    f.write_text(
        "name: t\nbaseline: latest\nsession: (inline)\nfidelity: container\nprompt: hi\n" + body,
        encoding="utf-8",
    )
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        code = scenario.main(["lint", str(f), *flags])
    return code, buf.getvalue()


def test_min_severity_defaults_to_unchanged(tmp_path):
    """Default floor is INFO — the existing INFO advisories still fire (no silent behavior change)."""
    code, out = _lint_cli(tmp_path)
    assert "manifest-needs-snapshot" in out
    assert code == 0


def test_min_severity_warn_drops_info(tmp_path):
    code, out = _lint_cli(tmp_path, "--min-severity", "WARN")
    assert "manifest-needs-snapshot" not in out
    assert code == 0


def test_strict_with_min_severity_error_is_not_a_contradiction(tmp_path):
    """`--strict --min-severity ERROR` behaves like a plain lint.

    --strict keys off the finding set. If the filter applied only at render, this would print
    "0 findings" and still exit 1 — indistinguishable from a bug. The filter runs before BOTH the
    render and the exit computation, so the two agree.
    """
    strict_only, _ = _lint_cli(tmp_path, "--strict")
    assert strict_only == 1  # an INFO exists at the default floor, so --strict fails
    filtered, out = _lint_cli(tmp_path, "--strict", "--min-severity", "ERROR")
    assert filtered == 0
    assert "manifest-needs-snapshot" not in out


def test_min_severity_filters_json_identically(tmp_path):
    """--json sees the same filtered set, or the two output modes disagree."""
    _, full = _lint_cli(tmp_path, "--json")
    _, filtered = _lint_cli(tmp_path, "--json", "--min-severity", "WARN")
    assert any(f["rule"] == "manifest-needs-snapshot" for f in json.loads(full))
    assert all(f["severity"] in ("ERROR", "WARN") for f in json.loads(filtered))


# --- vacuous-gate-assert: gate_answers_delivered needs a PRESENCE companion -------------------------
# `gate_answers_delivered` checks that every gate which fired was delivered non-error, and ZERO gates
# fired passes VACUOUSLY (gate firing is model-dependent). So the assertion that looks like it guards
# "the skill still asks its questions" stays green when the skill stops asking altogether -- the exact
# regression a real corpus had sit green for weeks against a 0-gate recording.
#
# A companion is any key that FAILS rather than vacuously passes on an empty gate set. The exemption
# list is load-bearing in both directions: too narrow and the rule reds `scaffold`'s own output (which
# emits question_asked alongside this key); too wide and it exempts `questions_count_max`, a MAX that
# passes vacuously at zero and leaves the hole open.

RULE = "vacuous-gate-assert"


def test_gate_answers_delivered_alone_warns(tmp_path):
    assert RULE in _rules("assert:\n  - gate_answers_delivered: true\n", tmp_path)


@pytest.mark.parametrize(
    "companion",
    [
        "gate_answer_count_min: 1",  # the explicit floor
        'question_asked: "which format"',  # fails "no question matched" on an empty set
        'tool_called: "AskUserQuestion"',  # fails "tool not called"
    ],
)
def test_presence_companion_silences_it(companion, tmp_path):
    body = f"assert:\n  - gate_answers_delivered: true\n  - {companion}\n"
    assert RULE not in _rules(body, tmp_path)


def test_questions_count_max_is_NOT_a_companion(tmp_path):
    # A MAX is satisfied by zero gates, so it cannot witness presence -- pairing it must still warn.
    body = "assert:\n  - gate_answers_delivered: true\n  - questions_count_max: 3\n"
    assert RULE in _rules(body, tmp_path)


def test_tool_called_for_an_unrelated_tool_is_not_a_companion(tmp_path):
    body = 'assert:\n  - gate_answers_delivered: true\n  - tool_called: "Bash"\n'
    assert RULE in _rules(body, tmp_path)


def test_tool_called_regex_matching_the_gate_tool_counts(tmp_path):
    # `tool_called` is a user REGEX over observed tool names, so the check asks whether THEIR pattern
    # would match the gate tool -- not whether they typed the name exactly.
    body = 'assert:\n  - gate_answers_delivered: true\n  - tool_called: "Ask.*Question"\n'
    assert RULE not in _rules(body, tmp_path)


def test_malformed_tool_called_regex_does_not_crash_the_linter(tmp_path):
    # An uncompilable regex is a different rule's finding; this one must not raise on it.
    body = 'assert:\n  - gate_answers_delivered: true\n  - tool_called: "[unclosed"\n'
    assert RULE in _rules(body, tmp_path)
