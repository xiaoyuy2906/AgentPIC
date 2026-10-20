"""Pin-coincidence extraction and corridor trimming, without GDS or a running workflow."""

import numpy as np
import pytest

from agentpic.lvs import _trimmed, extract_connectivity


def pin(x, y, orientation, width=1.0, domain="optical"):
    return {
        "center_um": [x, y],
        "orientation_deg": orientation,
        "width_um": width,
        "domain": domain,
    }


def test_facing_coincident_pins_connect_and_lone_pins_stay_open():
    ports = {
        "a": {"o1": pin(0, 0, 180), "o2": pin(10, 0, 0)},
        "b": {"o1": pin(10, 0, 180), "o2": pin(20, 0, 0)},
    }
    connections, open_pins, ambiguous = extract_connectivity(ports)
    assert connections == {"a,o2|b,o1"}
    assert open_pins == {"a,o1", "b,o2"}
    assert ambiguous == []


@pytest.mark.parametrize(
    "second",
    [
        pin(10, 0, 0),  # same direction: not a mated pair
        pin(10, 0, 180, width=2.0),  # width mismatch
    ],
)
def test_mismatched_coincident_pins_are_ambiguous(second):
    ports = {"a": {"o2": pin(10, 0, 0)}, "b": {"o1": second}}
    connections, _, ambiguous = extract_connectivity(ports)
    assert connections == set()
    assert ambiguous == [["a,o2", "b,o1"]]


def test_three_pins_at_one_point_are_ambiguous_and_domains_never_mix():
    ports = {
        "a": {"o1": pin(0, 0, 0), "e1": pin(0, 0, 180, domain="electrical")},
        "b": {"o1": pin(0, 0, 180)},
        "c": {"o1": pin(0, 0, 90)},
    }
    connections, open_pins, ambiguous = extract_connectivity(ports)
    assert connections == set()
    assert open_pins == {"a,e1"}
    assert ambiguous == [["a,o1", "b,o1", "c,o1"]]


def test_trimming_removes_the_requested_length_from_both_ends():
    line = np.array([[0.0, 0.0], [10.0, 0.0], [10.0, 10.0]])
    inner = _trimmed(line, 2.0)
    assert np.allclose(inner[0], [2, 0]) and np.allclose(inner[-1], [10, 8])
    assert np.allclose(inner[1], [10, 0])
    assert _trimmed(line, 10.0) is None
