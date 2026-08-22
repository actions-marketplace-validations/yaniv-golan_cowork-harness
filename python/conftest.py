"""pytest plugin: the `cowork` fixture + the `cowork` marker (B1, opt-in lane)."""
import os

import pytest

from cowork_harness import Cowork, lane_opted_in, pytest_collection_modifyitems  # noqa: F401


def pytest_configure(config):
    config.addinivalue_line(
        "markers",
        "cowork: opt-in lane — drives the cowork-harness (spawns node + Docker). "
        "Select with `-m cowork`; deselect in the fast loop with `-m 'not cowork'`.",
    )


@pytest.fixture
def cowork(request) -> Cowork:
    """A Cowork runner bound to the built CLI (COWORK_HARNESS_CLI or <repo>/dist/cli.js).

    Guarded as well as the collection hook, and not redundantly: the hook keys on the `cowork` MARKER,
    so a test that takes this fixture without wearing the marker sails past it and spends. Requesting
    the runner is the moment money starts, so the check also lives here.
    """
    if not lane_opted_in(getattr(request.config.option, "markexpr", "") or "", os.environ):
        pytest.skip(
            "cowork lane not requested: this fixture spawns the CLI, Docker and a real model (real cost). "
            "Run with `pytest -m cowork`, or set COWORK_HARNESS_PYTEST_LANE=1."
        )
    return Cowork()
