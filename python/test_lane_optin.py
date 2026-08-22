"""T-P3 — the paid `cowork` lane must stay opt-in, from the repo root and from a bare install.

`addopts = "-m 'not cowork'"` lived only in `python/pyproject.toml`. pytest reads the config at the
rootdir for the invocation, so `pytest` FROM THE REPO ROOT read none of it and collected the three
`@pytest.mark.cowork` tests — each spawning node, Docker and a real model. Two halves are guarded here:

  * the root `pytest.ini`, which fixes the repo-root invocation; and
  * `cowork_harness.lane_opted_in` + the collection hook + the fixture guard, which is the half that
    matters for a consumer, because INI config does not travel with an installed helper.

WHY THE MODULE HALF IS TESTED IN-PROCESS AND NOT BY RUNNING THE LANE. Demonstrating the guard red the
obvious way means letting the paid tests run — which is the thing being prevented. So the predicate and
the hook are exercised directly against fake items. Nothing here spawns anything.

WHY NO COLLECTED TOTAL IS PINNED. The plan's 153/150 were right when taken and stale a commit later.
This asserts the marker relation instead: whatever the totals are, the selected set and the cowork set
must not intersect.
"""
import os
import subprocess
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest

from cowork_harness import LANE_ENV, lane_opted_in, pytest_collection_modifyitems

REPO_ROOT = Path(__file__).resolve().parents[1]


def _collect(*args: str) -> set[str]:
    """Node ids pytest would SELECT for `args`, run from the repo root."""
    proc = subprocess.run(
        [sys.executable, "-m", "pytest", "--collect-only", "-q", "-p", "no:cacheprovider", *args],
        cwd=REPO_ROOT,
        capture_output=True,
        text=True,
        env={**os.environ, LANE_ENV: "0"},
    )
    if proc.returncode not in (0, 5):  # 5 = nothing collected
        raise AssertionError(f"collection failed ({proc.returncode}):\n{proc.stdout}\n{proc.stderr}")
    return {line.strip() for line in proc.stdout.splitlines() if "::" in line and not line.startswith(" ")}


# ── the root-config half ────────────────────────────────────────────────────────────────────────────

def test_the_repo_root_invocation_selects_no_paid_tests():
    # Ground truth, taken with addopts cleared so the CLI `-m` is authoritative.
    paid = _collect("-o", "addopts=", "-m", "cowork")
    assert paid, "no @pytest.mark.cowork tests found at all — this guard would be vacuous"

    selected = _collect()  # a bare `pytest` from the repo root
    assert selected, "a bare root collection found nothing — the runner, not the guard, is broken"
    leaked = sorted(paid & selected)
    assert not leaked, (
        "a bare `pytest` from the repo root selects paid lane tests — each spawns node, Docker and a "
        f"real model:\n  " + "\n  ".join(leaked)
    )


def test_the_documented_opt_in_still_selects_the_lane():
    # The counterweight: a guard that deselected the lane unconditionally would pass the test above and
    # silently delete the lane instead of gating it.
    assert _collect("-m", "cowork"), "`pytest -m cowork` selects nothing — the lane is unreachable"


# ── the module half: the predicate ──────────────────────────────────────────────────────────────────

@pytest.mark.parametrize(
    "markexpr,env,expected",
    [
        ("", {}, False),                        # a bare `pytest` — the consumer default
        ("not slow", {}, False),                # some other selection is not a request for the lane
        ("cowork", {}, True),                   # the documented invocation
        ("cowork or slow", {}, True),
        ("", {LANE_ENV: "1"}, True),            # explicit env opt-in
        ("", {LANE_ENV: "0"}, False),           # ...and its off switch
        ("", {LANE_ENV: ""}, False),
    ],
)
def test_lane_opted_in(markexpr, env, expected):
    assert lane_opted_in(markexpr, env) is expected


# ── the module half: the hook ───────────────────────────────────────────────────────────────────────

class _FakeItem:
    def __init__(self, *marker_names: str):
        self._markers = [SimpleNamespace(name=n) for n in marker_names]
        self.added: list = []

    def iter_markers(self):
        return list(self._markers)

    def add_marker(self, marker):
        self.added.append(marker)


def _config(markexpr: str = ""):
    return SimpleNamespace(option=SimpleNamespace(markexpr=markexpr))


def test_hook_skips_the_paid_tests_when_the_lane_was_not_requested(monkeypatch):
    monkeypatch.delenv(LANE_ENV, raising=False)
    paid, ordinary = _FakeItem("cowork"), _FakeItem("slow")
    pytest_collection_modifyitems(_config(""), [paid, ordinary])
    assert [m.name for m in paid.added] == ["skip"], "the paid test was left runnable"
    assert "pytest -m cowork" in paid.added[0].kwargs["reason"], "the skip does not say how to opt in"
    assert ordinary.added == [], "an unrelated test was skipped too"


def test_hook_leaves_the_lane_alone_once_requested(monkeypatch):
    monkeypatch.delenv(LANE_ENV, raising=False)
    paid = _FakeItem("cowork")
    pytest_collection_modifyitems(_config("cowork"), [paid])
    assert paid.added == [], "`-m cowork` was requested and the hook skipped the lane anyway"
