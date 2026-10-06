# -*- coding: utf-8 -*-
"""
test_vocal_chain.py
The voice chain (dubmate/vocal_chain.py): schema, presets, settings resolution,
legacy mapping and the pedalboard render (determinism, length, prefix renders,
pitch timing, reverb exactness, low-cut response).
Render tests skip only when pedalboard can't be imported; CI installs requirements.txt.
"""

import copy
import json
import os
import sys
import unittest

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from dubmate import vocal_chain as vc

SR = 44100
FIXTURE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "fixtures", "chain_resolution.json")
HAVE_PEDALBOARD = vc.available()


def _chain(value):
    """Fixture chains: a string is that preset's chain."""
    return copy.deepcopy(vc.PRESETS[value]["chain"]) if isinstance(value, str) else value


def _noise(seconds, seed=0, scale=0.2):
    return (np.random.default_rng(seed).standard_normal(int(seconds * SR)) * scale).astype(np.float32)


def _chain_with(**nodes):
    """Clean with some nodes changed; e.g. _chain_with(lowcut={"on": False})."""
    chain = copy.deepcopy(vc.CLEAN)
    for name, params in nodes.items():
        chain["nodes"][name].update(params)
    return vc.normalize_chain(chain)


class TestNormalizeChain(unittest.TestCase):

    def test_empty_dict_is_clean(self):
        chain = vc.normalize_chain({})
        self.assertEqual(chain["nodes"], vc.CLEAN["nodes"])
        self.assertEqual(chain["v"], 1)
        self.assertIsNone(chain["preset"])
        self.assertEqual(list(chain["nodes"]), list(vc.NODE_ORDER))

    def test_fills_missing_params_from_clean(self):
        chain = vc.normalize_chain({"nodes": {"comp": {"on": True, "ratio": 5}}})
        comp = chain["nodes"]["comp"]
        self.assertEqual((comp["on"], comp["ratio"]), (True, 5.0))
        self.assertEqual(comp["threshold_db"], -18.0)
        self.assertEqual(comp["mix"], 1.0)
        self.assertEqual(chain["nodes"]["lowcut"], vc.CLEAN["nodes"]["lowcut"])

    def test_clamps_every_value(self):
        chain = vc.normalize_chain({"nodes": {
            "lowcut": {"hz": 5000, "mix": 3},
            "gate": {"threshold_db": -500},
            "eq": {"low_db": 40, "mid_hz": 1, "high_db": -40},
            "pitch": {"semitones": 30},
            "reverb": {"decay_s": 99, "predelay_ms": -4, "mix": -1},
        }})
        nodes = chain["nodes"]
        self.assertEqual(nodes["lowcut"]["hz"], 400.0)
        self.assertEqual(nodes["lowcut"]["mix"], 1.0)
        self.assertEqual(nodes["gate"]["threshold_db"], -80.0)
        self.assertEqual((nodes["eq"]["low_db"], nodes["eq"]["mid_hz"], nodes["eq"]["high_db"]), (12.0, 300.0, -12.0))
        self.assertEqual(nodes["pitch"]["semitones"], 12)
        self.assertEqual((nodes["reverb"]["decay_s"], nodes["reverb"]["predelay_ms"], nodes["reverb"]["mix"]), (4.0, 0.0, 0.0))

    def test_rounds_and_steps(self):
        chain = vc.normalize_chain({"nodes": {"comp": {"ratio": 2.123456}, "pitch": {"semitones": -2.6}}})
        self.assertEqual(chain["nodes"]["comp"]["ratio"], 2.123)
        self.assertEqual(chain["nodes"]["pitch"]["semitones"], -3)
        self.assertIsInstance(chain["nodes"]["pitch"]["semitones"], int)

    def test_drops_unknown_keys_and_bad_values(self):
        chain = vc.normalize_chain({"v": 7, "extra": 1, "preset": "nope", "nodes": {
            "lowcut": {"hz": "loud", "on": "yes", "colour": "red"},
            "chorus": {"on": True},
            "comp": {"threshold_db": float("nan"), "ratio": True},
        }})
        self.assertEqual(set(chain), {"v", "preset", "nodes"})
        self.assertEqual(chain["v"], 1)
        self.assertIsNone(chain["preset"])
        self.assertEqual(set(chain["nodes"]), set(vc.NODE_ORDER))
        self.assertEqual(chain["nodes"]["lowcut"], vc.CLEAN["nodes"]["lowcut"])
        self.assertEqual(chain["nodes"]["comp"]["threshold_db"], -18.0)
        self.assertEqual(chain["nodes"]["comp"]["ratio"], 3.0)

    def test_non_dict_raises(self):
        for bad in (None, [], "warm", 3):
            with self.assertRaises(ValueError):
                vc.normalize_chain(bad)

    def test_presets_normalize_to_themselves(self):
        self.assertEqual(list(vc.PRESETS), ["clean", "warm", "radio", "monster"])
        for preset_id, preset in vc.PRESETS.items():
            self.assertTrue(preset["name"])
            self.assertEqual(preset["chain"]["preset"], preset_id)
            self.assertEqual(vc.normalize_chain(preset["chain"]), preset["chain"], preset_id)

    def test_preset_label_kept_only_while_untouched(self):
        edited = copy.deepcopy(vc.PRESETS["warm"]["chain"])
        edited["nodes"]["comp"]["ratio"] = 4
        self.assertIsNone(vc.normalize_chain(edited)["preset"])
        self.assertIsNone(vc.normalize_chain({"preset": "radio"})["preset"])

    def test_preset_values_from_the_design(self):
        radio = vc.PRESETS["radio"]["chain"]["nodes"]
        self.assertEqual(radio["lowcut"]["hz"], 300.0)
        self.assertEqual((radio["eq"]["low_db"], radio["eq"]["mid_db"], radio["eq"]["mid_hz"], radio["eq"]["high_db"]), (-6.0, 5.0, 1800.0, -10.0))
        self.assertEqual((radio["comp"]["threshold_db"], radio["comp"]["ratio"], radio["comp"]["makeup_db"]), (-24.0, 4.0, 6.0))
        self.assertFalse(radio["reverb"]["on"])
        monster = vc.PRESETS["monster"]["chain"]["nodes"]
        self.assertEqual((monster["pitch"]["on"], monster["pitch"]["semitones"]), (True, -5))
        self.assertEqual((monster["reverb"]["mix"], monster["reverb"]["decay_s"], monster["reverb"]["predelay_ms"]), (0.25, 1.8, 25.0))
        clean = vc.CLEAN["nodes"]
        self.assertEqual([n for n in vc.NODE_ORDER if clean[n]["on"]], ["lowcut"])
        self.assertEqual(clean["lowcut"]["hz"], 80.0)


class TestResolution(unittest.TestCase):

    def test_fixture_cases(self):
        with open(FIXTURE, "r", encoding="utf-8") as fh:
            cases = json.load(fh)["cases"]
        self.assertGreaterEqual(len(cases), 5)
        for case in cases:
            voice = case["voice"]
            if voice is not None:
                voice = {"session": _chain(voice["session"]),
                         "characters": {k: _chain(v) for k, v in voice["characters"].items()}}
            take = case["take"]
            if take is not None and "chain" in take:
                take = dict(take, chain=_chain(take["chain"]))
            resolved = vc.resolve_chain(voice, case["character"], take)
            self.assertEqual(resolved, vc.normalize_chain(_chain(case["expect"])), case["name"])

    def test_fixture_presets_are_the_engine_presets(self):
        """The studio's tests read the presets from the fixture (and check its Clean
        fallback against it), so the fixture must spell out the engine's presets exactly."""
        with open(FIXTURE, "r", encoding="utf-8") as fh:
            presets = json.load(fh)["presets"]
        self.assertEqual(presets, {pid: p["chain"] for pid, p in vc.PRESETS.items()})

    def test_returns_a_copy(self):
        voice = {"session": copy.deepcopy(vc.PRESETS["radio"]["chain"]), "characters": {}}
        resolved = vc.resolve_chain(voice, None, None)
        resolved["nodes"]["lowcut"]["hz"] = 41
        self.assertEqual(voice["session"]["nodes"]["lowcut"]["hz"], 300.0)
        vc.resolve_chain(None, None, None)["nodes"]["lowcut"]["hz"] = 41
        self.assertEqual(vc.CLEAN["nodes"]["lowcut"]["hz"], 80.0)


class TestLegacyMapping(unittest.TestCase):

    def test_pitch_and_reverb(self):
        chain = vc.chain_from_legacy(-3, 0.4)
        nodes = chain["nodes"]
        self.assertEqual((nodes["pitch"]["on"], nodes["pitch"]["semitones"]), (True, -3))
        self.assertEqual((nodes["reverb"]["on"], nodes["reverb"]["mix"]), (True, 0.4))
        self.assertEqual((nodes["reverb"]["decay_s"], nodes["reverb"]["predelay_ms"]), (1.5, 20.0))
        for name in ("lowcut", "gate", "eq", "deess", "comp"):
            self.assertEqual(nodes[name], vc.CLEAN["nodes"][name])
        self.assertIsNone(chain["preset"])

    def test_only_the_nodes_set(self):
        reverb_only = vc.chain_from_legacy(0, 0.3)["nodes"]
        self.assertFalse(reverb_only["pitch"]["on"])
        self.assertTrue(reverb_only["reverb"]["on"])
        pitch_only = vc.chain_from_legacy(5, 0.0)["nodes"]
        self.assertTrue(pitch_only["pitch"]["on"])
        self.assertFalse(pitch_only["reverb"]["on"])
        # The old export ignored reverb at 0.02 or less.
        self.assertFalse(vc.chain_from_legacy(0, 0.02)["nodes"]["reverb"]["on"])
        self.assertEqual(vc.chain_from_legacy(0, 0), vc.normalize_chain(vc.CLEAN))
        self.assertEqual(vc.chain_from_legacy(0, 0)["preset"], "clean")

    def test_chain_with_legacy_keeps_the_rest(self):
        warm = copy.deepcopy(vc.PRESETS["warm"]["chain"])
        out = vc.chain_with_legacy(warm, pitch=2)
        self.assertEqual((out["nodes"]["pitch"]["on"], out["nodes"]["pitch"]["semitones"]), (True, 2))
        self.assertEqual(out["nodes"]["reverb"], warm["nodes"]["reverb"])
        self.assertIsNone(out["preset"])
        out = vc.chain_with_legacy(warm, reverb_wet=0.5)
        self.assertEqual(out["nodes"]["reverb"], dict(warm["nodes"]["reverb"], mix=0.5))
        self.assertEqual(out["nodes"]["pitch"], warm["nodes"]["pitch"])
        out = vc.chain_with_legacy(warm, pitch=0, reverb_wet=0)
        self.assertFalse(out["nodes"]["pitch"]["on"])
        self.assertEqual(out["nodes"]["reverb"], dict(warm["nodes"]["reverb"], on=False))
        self.assertEqual(vc.chain_with_legacy(warm), warm)
        self.assertEqual(warm, vc.PRESETS["warm"]["chain"], "input must not be mutated")


class TestReverbImpulse(unittest.TestCase):

    def test_identical_up_to_two_seconds_and_longer_beyond(self):
        vc._REVERB_CACHE.clear()
        self.assertEqual(len(vc.get_reverb_impulse(1.5, SR)), int(SR * 1.5))
        self.assertEqual(len(vc.get_reverb_impulse(3.0, SR)), int(SR * 3.0))
        self.assertEqual(len(vc.get_reverb_impulse(9.0, SR)), int(SR * 4.0))
        self.assertEqual(len(vc.get_reverb_impulse(0.05, SR)), int(SR * 0.2))

    def test_predelay(self):
        vc._REVERB_CACHE.clear()
        impulse = vc.get_reverb_impulse(1.0, SR, predelay_ms=40)
        start = int(np.argmax(np.abs(impulse) > 0))
        self.assertEqual(start, int(SR * 0.040))
        self.assertEqual(int(np.argmax(np.abs(vc.get_reverb_impulse(1.0, SR)) > 0)), int(SR * 0.020))
        self.assertEqual(int(np.argmax(np.abs(vc.get_reverb_impulse(1.0, SR, predelay_ms=0)) > 0)), 0)


@unittest.skipUnless(HAVE_PEDALBOARD, "pedalboard is not installed")
class TestRender(unittest.TestCase):

    def test_deterministic(self):
        x = _noise(2.0, seed=4)
        for preset_id, preset in vc.PRESETS.items():
            a = vc.render(x, preset["chain"])
            b = vc.render(x, copy.deepcopy(preset["chain"]))
            np.testing.assert_array_equal(a, b, err_msg=preset_id)
            self.assertEqual(a.dtype, np.float32)

    def test_length_kept_without_reverb(self):
        x = _noise(1.3, seed=5)
        for preset_id in ("clean", "radio"):
            self.assertEqual(len(vc.render(x, vc.PRESETS[preset_id]["chain"])), len(x), preset_id)
        pitched = _chain_with(pitch={"on": True, "semitones": 7})
        self.assertEqual(len(vc.render(x, pitched)), len(x))

    def test_reverb_pads_the_tail(self):
        x = _noise(1.0, seed=6)
        chain = _chain_with(reverb={"on": True, "decay_s": 2.5})
        expected = len(x) + int(round(0.1 * SR)) + int(SR * 2.5)
        self.assertEqual(len(vc.render(x, chain)), expected)

    def test_prefix_render_equals_full_render(self):
        x = _noise(4.0, seed=7) * np.sin(np.linspace(0, 25, int(4.0 * SR))).astype(np.float32)
        for preset_id, preset in vc.PRESETS.items():
            full = vc.render(x, preset["chain"])
            prefix = vc.render(x, preset["chain"], until_s=1.5)
            self.assertEqual(len(prefix), int(1.5 * SR), preset_id)
            np.testing.assert_allclose(prefix, full[:len(prefix)], rtol=0, atol=1e-6, err_msg=preset_id)

    def test_empty_audio(self):
        self.assertEqual(len(vc.render(np.zeros(0, dtype=np.float32), vc.PRESETS["radio"]["chain"])), 0)

    def _onset_shift_ms(self, semitones, seed):
        x = np.zeros(2 * SR, dtype=np.float32)
        start, length = int(0.7 * SR), int(0.4 * SR)
        x[start:start + length] = _noise(0.4, seed=seed, scale=0.3)
        chain = _chain_with(lowcut={"on": False}, pitch={"on": semitones != 0, "semitones": semitones})
        y = vc.render(x, chain)
        window = np.ones(int(0.005 * SR)) / int(0.005 * SR)

        def onset(signal, frac):
            envelope = np.convolve(np.abs(signal.astype(np.float64)), window, mode="same")
            return int(np.argmax(envelope >= frac * envelope.max()))

        return [(onset(y, f) - onset(x, f)) * 1000.0 / SR for f in (0.1, 0.2, 0.3, 0.4, 0.5)]

    def test_pitch_onset_shift_is_small(self):
        for seed in (1, 2, 3):
            self.assertEqual(self._onset_shift_ms(0, seed), [0.0] * 5, "pitch off must not move anything")
            for semitones, limit in ((5, 15.0), (-5, 15.0), (12, 25.0), (-12, 25.0)):
                shifts = self._onset_shift_ms(semitones, seed)
                self.assertLessEqual(max(abs(s) for s in shifts), limit, f"{semitones} st, seed {seed}: {shifts}")

    def test_legacy_reverb_is_exact(self):
        x = _noise(1.0, seed=8)
        chain = vc.chain_from_legacy(0, 0.4)
        chain["nodes"]["lowcut"]["on"] = False
        out = vc.render(x, chain)
        impulse = vc.get_reverb_impulse(1.5, SR)
        wet = vc._fft_convolve(x, impulse)
        expected = np.zeros(len(out), dtype=np.float64)
        expected[:len(wet)] += 0.4 * 0.7 * wet
        expected[:len(x)] += x
        np.testing.assert_allclose(out, expected, rtol=0, atol=1e-5)

    def test_low_cut_magnitude(self):
        impulse = np.zeros(SR, dtype=np.float32)
        impulse[0] = 1.0
        response = vc.render(impulse, vc.CLEAN).astype(np.float64)
        spectrum = np.abs(np.fft.rfft(response))
        freqs = np.fft.rfftfreq(len(response), 1.0 / SR)

        def db_at(hz):
            return 20 * np.log10(spectrum[int(np.argmin(np.abs(freqs - hz)))])

        self.assertAlmostEqual(db_at(80), -3.0, delta=0.2)
        self.assertAlmostEqual(db_at(40), -8.5, delta=0.5)
        self.assertAlmostEqual(db_at(1000), 0.0, delta=0.2)

    def test_mix_blends_dry_and_wet(self):
        x = _noise(0.5, seed=9)
        dry = vc.render(x, _chain_with(lowcut={"on": False}))
        wet = vc.render(x, _chain_with(lowcut={"on": False}, comp={"on": True, "threshold_db": -30, "ratio": 8}))
        half = vc.render(x, _chain_with(lowcut={"on": False}, comp={"on": True, "threshold_db": -30, "ratio": 8, "mix": 0.5}))
        np.testing.assert_allclose(half, dry + 0.5 * (wet - dry), rtol=0, atol=1e-6)
        np.testing.assert_array_equal(dry, x)


class TestSelfInstall(unittest.TestCase):

    def setUp(self):
        self._env = os.environ.pop("DUBMATE_TOOLS_DIR", None)

    def tearDown(self):
        os.environ.pop("DUBMATE_TOOLS_DIR", None)
        if self._env is not None:
            os.environ["DUBMATE_TOOLS_DIR"] = self._env
        vc._install_state = None

    def test_pin_comes_from_requirements(self):
        requirements = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "requirements.txt")
        self.assertEqual(vc._pinned_version(requirements), "0.9.25")
        self.assertIsNone(vc._pinned_version(os.path.join(os.path.dirname(requirements), "missing.txt")))

    def test_source_installs_never_start_it(self):
        from unittest import mock
        with mock.patch.object(vc.threading, "Thread") as thread:
            vc.start_self_install("/tmp/cache", "requirements.txt")
        thread.assert_not_called()

    def test_desktop_installs_the_pin_into_the_cache(self):
        import tempfile
        from unittest import mock
        os.environ["DUBMATE_TOOLS_DIR"] = "tools"
        calls = []
        imported = iter([False, True, True])  # before the install, after it, final status

        def fake_run(cmd, **kwargs):
            calls.append((cmd, kwargs))
            return mock.Mock(returncode=0, stdout="", stderr="")

        with tempfile.TemporaryDirectory() as cache, \
                mock.patch.object(vc, "available", lambda cache_dir=None: next(imported)), \
                mock.patch.object(vc.subprocess, "run", fake_run), \
                mock.patch.object(vc.threading, "Thread") as thread:
            req = os.path.join(cache, "requirements.txt")
            with open(req, "w", encoding="utf-8") as fh:
                fh.write("numpy>=1.24.0\npedalboard==0.9.25\n")
            vc.start_self_install(cache, req)
            self.assertEqual(vc.install_status(), "installing")
            thread.call_args.kwargs["target"]()  # run the worker inline
            cmd, kwargs = calls[0]
            target = os.path.join(cache, "engine-packages", f"py{sys.version_info[0]}{sys.version_info[1]}")
            self.assertEqual(cmd, [sys.executable, "-m", "pip", "install", "--no-input", "--no-deps",
                                   "--target", target, "pedalboard==0.9.25"])
            self.assertEqual(kwargs["timeout"], 300)
            self.assertTrue(os.path.isdir(target))
            self.assertEqual(vc._install_state, "ready")


if __name__ == "__main__":
    unittest.main(verbosity=2)
