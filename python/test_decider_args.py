"""argv construction for the answer channels — no marker, so this runs in the fast lane (no node, no Docker).

`Skill.run(decider_cmd=...)` was a guaranteed usage error before this was guarded: the method emitted
`--on-unanswered <policy>` unconditionally, and the CLI rejects a terminal CHANNEL alongside the POLICY
(the channel IS the terminal, so the policy could only ever be inert). Nothing caught it because nothing
asserted on the argv, and the `cowork`-marked lane that would have hit it is opt-in and costs money.

`decider_dir` is added here alongside — the in-band channel had no Python surface at all, which made the
"scripted answers are all this supports" reading simply true from inside this API.
"""
import pytest

from cowork_harness import Cowork, Skill


class _CaptureRunner:
    """Stands in for the CLI runner and records the argv that would have been spawned."""

    def __init__(self):
        self.calls = []

    def _invoke(self, args, check=False):
        self.calls.append(args)
        return None


@pytest.fixture
def skill():
    s = Skill.__new__(Skill)
    s._folder = "/tmp/my-skill"
    s._runner = _CaptureRunner()
    return s


def _argv(skill):
    return skill._runner.calls[-1]


def test_plain_run_still_sends_the_on_unanswered_policy(skill):
    """The default path is unchanged — the policy is only dropped when a channel takes over."""
    skill.run("p")
    assert "--on-unanswered" in _argv(skill)
    assert "fail" in _argv(skill)


def test_a_custom_on_unanswered_is_still_honored(skill):
    skill.run("p", on_unanswered="first")
    argv = _argv(skill)
    assert argv[argv.index("--on-unanswered") + 1] == "first"


@pytest.mark.parametrize(
    "kwargs,flag,value",
    [
        ({"decider_cmd": "python helper.py"}, "--decider-cmd", "python helper.py"),
        ({"decider_dir": "/tmp/gates"}, "--decider-dir", "/tmp/gates"),
    ],
)
def test_a_channel_emits_its_flag_and_drops_the_policy(skill, kwargs, flag, value):
    """The regression that mattered: a channel plus --on-unanswered is exit 2 at the CLI."""
    skill.run("p", **kwargs)
    argv = _argv(skill)
    assert flag in argv
    assert argv[argv.index(flag) + 1] == value
    assert "--on-unanswered" not in argv, (
        "a terminal channel must not be paired with the --on-unanswered policy — the CLI rejects it"
    )


def test_the_two_channels_are_mutually_exclusive(skill):
    with pytest.raises(ValueError, match="mutually exclusive"):
        skill.run("p", decider_cmd="cat", decider_dir="/tmp/gates")


def test_channels_still_compose_with_json_output(skill):
    """Every channel keeps stdout free; the JSON envelope must survive on both."""
    for kwargs in ({"decider_cmd": "cat"}, {"decider_dir": "/tmp/gates"}):
        skill.run("p", **kwargs)
        argv = _argv(skill)
        assert argv[argv.index("--output-format") + 1] == "json"


def test_skill_run_exposes_both_channels_in_its_signature():
    """A consumer reading `help(Skill.run)` must be able to SEE that the in-band channel exists.

    Discoverability is the whole point of this parameter: an API that supports only `decider_cmd` teaches,
    accurately, that in-band answering is not available from Python.
    """
    import inspect

    params = inspect.signature(Skill.run).parameters
    assert "decider_dir" in params
    assert "decider_cmd" in params
