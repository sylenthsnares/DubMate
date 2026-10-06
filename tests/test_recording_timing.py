"""Take timing: alignment math (audio_processor.align_take_timing) on synthetic signals,
auto-aligned offsets on upload, the best-timed delete fallback, and rooms saved before it."""
import json
import os
import shutil
import sys
import unittest
from unittest import mock

import numpy as np

TESTS_DIR = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(TESTS_DIR))
sys.path.insert(0, TESTS_DIR)

import audio_processor
from audio_processor import SR, align_take_timing
from dubmate import rooms
from test_take_model import RoomCase


def speech_like(seed=1, duration=4.0, lead=0.4):
    """Amplitude-modulated noise bursts with irregular syllable spacing."""
    rng = np.random.default_rng(seed)
    out = np.zeros(int(duration * SR))
    t = lead
    while t < duration - 0.5:
        length = rng.uniform(0.08, 0.3)
        n = int(length * SR)
        i = int(t * SR)
        env = np.sin(np.linspace(0, np.pi, n)) ** 2 * rng.uniform(0.2, 1.0)
        out[i:i + n] += rng.standard_normal(n) * env * 0.3
        t += length + rng.uniform(0.03, 0.35)
    return out


def delayed(x, ms):
    pad = np.zeros(int(round(ms * SR / 1000)))
    return np.concatenate([pad, x])


def time_stretched(x, factor):
    """Slow down by `factor` (>1 makes it longer)."""
    n = int(round(len(x) * factor))
    return np.interp(np.arange(n) / factor, np.arange(len(x)), x)


class AlignTakeTimingTests(unittest.TestCase):
    def setUp(self):
        self.ref = speech_like()

    def assertSane(self, res):
        self.assertEqual(set(res), {"auto_offset_ms", "timing_score", "stretch", "aligned"})
        self.assertIsInstance(res["auto_offset_ms"], int)
        self.assertEqual(res["auto_offset_ms"] % 5, 0)
        json.dumps(res, allow_nan=False)

    def test_late_take_gets_negative_offset(self):
        res = align_take_timing(delayed(self.ref, 140), self.ref, 0)
        self.assertSane(res)
        self.assertTrue(res["aligned"])
        self.assertLessEqual(abs(res["auto_offset_ms"] - (-140)), 5)
        self.assertGreater(res["timing_score"], 0.9)
        self.assertEqual(res["stretch"], 1.0)

    def test_start_offset_does_not_bias_result(self):
        res = align_take_timing(delayed(self.ref, 140), self.ref, -100)
        self.assertSane(res)
        self.assertTrue(res["aligned"])
        self.assertLessEqual(abs(res["auto_offset_ms"] - (-140)), 5)

    def test_offsets_are_multiples_of_five(self):
        for ms, start in ((37, 0), (212, 13), (0, -22), (73, 41)):
            res = align_take_timing(delayed(self.ref, ms), self.ref, start)
            self.assertSane(res)
            self.assertLessEqual(abs(res["auto_offset_ms"] + ms), 5)

    def test_slow_take_is_stretched(self):
        take = delayed(time_stretched(self.ref, 1.06), 60)
        res = align_take_timing(take, self.ref, 0)
        plain = align_take_timing(take, self.ref, 0, allow_stretch=False)
        self.assertSane(res)
        self.assertTrue(res["aligned"])
        self.assertLessEqual(abs(res["stretch"] - 1.06), 0.01)
        self.assertEqual(plain["stretch"], 1.0)
        self.assertGreater(res["timing_score"], plain["timing_score"] or 0)

    def test_small_drift_is_not_stretched(self):
        res = align_take_timing(delayed(time_stretched(self.ref, 1.01), 60), self.ref, 0)
        self.assertSane(res)
        self.assertEqual(res["stretch"], 1.0)

    def test_allow_stretch_false_never_stretches(self):
        for f in (0.94, 1.06, 1.1):
            res = align_take_timing(time_stretched(self.ref, f), self.ref, 0, allow_stretch=False)
            self.assertSane(res)
            self.assertEqual(res["stretch"], 1.0)

    def test_silence_is_not_measured(self):
        silence = np.zeros(SR * 2)
        for take, ref in ((silence, self.ref), (self.ref, silence), (silence, silence)):
            res = align_take_timing(take, ref, 20)
            self.assertSane(res)
            self.assertEqual(res, {"auto_offset_ms": 20, "timing_score": None, "stretch": 1.0, "aligned": False})

    def test_take_model_fixture_tones_not_measured(self):
        t1 = np.arange(int(0.5 * SR)) / SR
        t2 = np.arange(int(0.25 * SR)) / SR
        take = 0.3 * np.sin(2 * np.pi * 300 * t1)
        ref = 0.3 * np.sin(2 * np.pi * 180 * t2)
        res = align_take_timing(take, ref, 25)
        self.assertSane(res)
        self.assertEqual(res, {"auto_offset_ms": 25, "timing_score": None, "stretch": 1.0, "aligned": False})

    def test_noise_against_speech_not_aligned(self):
        noise = np.random.default_rng(7).standard_normal(len(self.ref)) * 0.1
        res = align_take_timing(noise, self.ref, 0)
        self.assertSane(res)
        self.assertFalse(res["aligned"])
        self.assertEqual(res["auto_offset_ms"], 0)
        self.assertEqual(res["stretch"], 1.0)

    def test_different_lines_not_aligned(self):
        res = align_take_timing(speech_like(seed=42), self.ref, 0)
        self.assertSane(res)
        self.assertFalse(res["aligned"])

    def test_start_offset_snapped(self):
        res = align_take_timing(np.zeros(100), self.ref, 23)
        self.assertEqual(res["auto_offset_ms"], 25)

    def test_envelope_floor(self):
        env = audio_processor._timing_envelope(self.ref, SR)
        self.assertAlmostEqual(env.max() - env.min(), 50.0, places=6)


TIMING_FIELDS = ("start_offset_ms", "auto_offset_ms", "aligned", "stretch", "timing_score")


class TimingRoomCase(RoomCase):
    """RoomCase whose first line (t1000) holds a speech-like original voice."""

    def setUp(self):
        super().setUp()
        self.ref = speech_like(duration=2.5, lead=0.3)
        line = self.pack.lines[0]
        audio_processor.write_wav_mono(os.path.join(self.pack.folder, line["filename"]), self.ref, SR)


class TestBestTimedFallback(TimingRoomCase):
    def _room_with(self, *scores):
        room = self._room()
        for n, score in enumerate(scores):
            self._add(room, "t1000", 300 + 100 * n, timing_score=score)
        return room

    def test_deleting_picked_take_falls_back_to_best_timing(self):
        room = self._room_with(0.9, 0.4, None, 0.7)
        self.assertEqual(room.remove_take("t1000", "k600"), "k300")
        room.pick_take("t1000", "k400")
        self.assertEqual(room.remove_take("t1000", "k400"), "k300")

    def test_ties_go_to_the_newest(self):
        room = self._room_with(0.8, 0.8, 0.5)
        room.pick_take("t1000", "k500")
        self.assertEqual(room.remove_take("t1000", "k500"), "k400")

    def test_unscored_takes_rank_lowest(self):
        room = self._room_with(0.2, None, None)
        self.assertEqual(room.remove_take("t1000", "k500"), "k300")

    def test_all_unscored_falls_back_to_newest(self):
        room = self._room_with(None, None, None)
        room.pick_take("t1000", "k400")
        self.assertEqual(room.remove_take("t1000", "k400"), "k500")

    def test_deleting_other_take_keeps_pick(self):
        room = self._room_with(0.9, 0.1)
        self.assertEqual(room.remove_take("t1000", "k300"), "k400")


class TestAlignedUpload(TimingRoomCase):
    @classmethod
    def setUpClass(cls):
        import app
        from starlette.testclient import TestClient
        cls.client = TestClient(app.app)

    def _upload(self, line_id, audio, status=200, **form):
        data = {"user_id": "hostT", "user_name": "Ana", "noise_reduction": "false"}
        data.update({k: str(v) for k, v in form.items()})
        path = os.path.join(self.cache, "upload.wav")
        audio_processor.write_wav_mono(path, audio, SR)
        with open(path, "rb") as f:
            body = f.read()
        res = self.client.post(f"/api/rooms/{self.ROOM}/lines/{line_id}/takes",
                               files={"file": ("take.wav", body, "audio/wav")}, data=data)
        self.assertEqual(res.status_code, status, res.text)
        return res.json().get("take")

    def _until(self, ws, msg_type):
        while (msg := ws.receive_json())["type"] != msg_type:
            pass
        return msg

    def test_late_take_is_lined_up(self):
        room = self._room()
        with self.client.websocket_connect(f"/ws/{self.ROOM}/hostT") as ws:
            wire = self._upload("t1000", delayed(self.ref, 140), offset_ms=0)
            msg = self._until(ws, "take_recorded")
        take = room.picked_take("t1000")
        self.assertLessEqual(abs(take["auto_offset_ms"] + 140), 5)
        self.assertEqual(take["offset_ms"], take["auto_offset_ms"])
        self.assertEqual(take["auto_offset_ms"] % 5, 0)
        self.assertTrue(take["aligned"])
        self.assertGreater(take["timing_score"], 0.5)
        self.assertEqual(take["start_offset_ms"], 0)
        self.assertEqual(take["stretch"], 1.0)
        for field in TIMING_FIELDS + ("offset_ms",):
            self.assertEqual(wire[field], take[field])
        self.assertEqual(set(msg["payload"]), {"line_id", "line_index", "take_id", "url",
                                               "noise_reduction", "user_name", "user_id"})
        state_take = msg["state"]["takes"]["t1000"]["takes"][0]
        for field in TIMING_FIELDS + ("offset_ms",):
            self.assertEqual(state_take[field], take[field])
        json.dumps(room.to_state_dict(), allow_nan=False)
        room._sync_save_to_disk()
        with open(self._state_file(), encoding="utf-8") as f:
            json.loads(f.read(), parse_constant=lambda c: self.fail(f"{c} in room_state.json"))

    def test_starting_offset_is_snapped(self):
        room = self._room()
        tone = 0.2 * np.sin(2 * np.pi * 300 * np.arange(SR // 2) / SR)
        self._upload("t3000", tone, offset_ms=-137)
        take = room.picked_take("t3000")
        self.assertEqual(take["start_offset_ms"], -135)
        self.assertEqual(take["offset_ms"], -135)
        self.assertEqual(take["auto_offset_ms"], -135)
        self.assertIsNone(take["timing_score"])
        self.assertFalse(take["aligned"])

    def test_guide_voice_take_is_not_lined_up(self):
        room = self._room()
        self._upload("t1000", delayed(self.ref, 140), offset_ms=-100, guide_voice="true")
        take = room.picked_take("t1000")
        self.assertEqual(take["offset_ms"], -100)
        self.assertEqual(take["start_offset_ms"], -100)
        self.assertEqual(take["auto_offset_ms"], -100)
        self.assertIsNone(take["timing_score"])
        self.assertFalse(take["aligned"])
        self.assertEqual(take["stretch"], 1.0)

    def test_missing_original_line_is_not_measured(self):
        room = self._room()
        os.remove(os.path.join(self.pack.folder, self.pack.lines[0]["filename"]))
        self._upload("t1000", delayed(self.ref, 140), offset_ms=20)
        take = room.picked_take("t1000")
        self.assertEqual((take["offset_ms"], take["start_offset_ms"], take["auto_offset_ms"]), (20, 20, 20))
        self.assertIsNone(take["timing_score"])
        self.assertFalse(take["aligned"])


class TestRoomSavedBeforeTiming(TimingRoomCase):
    """A room_state.json written by the take model (PR #12): version 2, takes without
    timing fields."""

    @classmethod
    def setUpClass(cls):
        import app
        from starlette.testclient import TestClient
        cls.client = TestClient(app.app)

    def _old_take(self, take_id, number, offset_ms, recorded_at):
        return {"take_id": take_id, "user_id": "hostT", "user_name": "Ana", "duration": 0.25,
                "peaks": [[0.1, 0.2]], "audio_version": 1790000000123, "offset_ms": offset_ms,
                "pitch_semitones": 0.0, "reverb_wet": 0.0, "gain_db": 0.0,
                "noise_reduction": False, "has_raw": True, "speech_loudness_db": -18.1,
                "target_loudness_db": -21.3, "auto_gain_db": -3.2, "recorded_at": recorded_at,
                "number": number}

    def _write_old_state(self):
        takes = {
            "t1000": {"picked": "k2", "next_number": 4, "takes": [
                self._old_take("k1", 1, 40, 1790000000.0),
                self._old_take("k2", 2, -25, 1790000100.0),
                self._old_take("k3", 3, 120, 1790000200.0)]},
            "t3000": {"picked": "k4", "next_number": 2, "takes": [
                self._old_take("k4", 1, 0, 1790000300.0)]},
        }
        for line_id, entry in takes.items():
            d = audio_processor.take_dir(self.ROOM, line_id)
            for take in entry["takes"]:
                for suffix in ("", "_raw"):
                    self._wav(os.path.join(d, f"{take['take_id']}{suffix}.wav"), 300)
        state = {"state_version": 2, "room_id": self.ROOM, "pack_id": self.PACK_ID, "host_id": "hostT",
                 "users": {"hostT": {"id": "hostT", "name": "Host", "color": "#7c5cff",
                                     "is_host": True, "is_online": False}},
                 "role_assignments": {"Ana": ["hostT"], "Ben": []},
                 "takes": takes, "status": "recording", "exported_video_path": None}
        with open(self._state_file(), "w", encoding="utf-8") as f:
            json.dump(state, f)
        return json.loads(json.dumps(takes))

    def test_old_room_loads_and_plays_as_before(self):
        old = self._write_old_state()
        room = self._reload()
        self.assertEqual(room.takes, old)
        mix = room.mix_takes()
        self.assertEqual((mix[0]["offset_ms"], mix[1]["offset_ms"]), (-25, 0))
        for field in TIMING_FIELDS:
            self.assertNotIn(field, mix[0])

        # The take lands at line.start + offset_ms in the render, as before.
        out = os.path.join(self.cache, "mix.wav")
        audio_processor.render_dub_mix(self.pack, {0: mix[0]}, out)
        rendered = audio_processor.read_wav_mono(out)
        first = int(np.argmax(np.abs(rendered) > 1e-3))
        self.assertLessEqual(abs(first / SR - (1.0 - 0.025)), 0.003)

    def test_save_keeps_old_takes_as_they_were(self):
        old = self._write_old_state()
        room = self._reload()
        upload = self._wav(os.path.join(self.cache, "u.wav"), 300, 0.5)
        res = self.client.post(f"/api/rooms/{self.ROOM}/lines/t5000/takes",
                               files={"file": ("take.wav", upload, "audio/wav")},
                               data={"user_id": "hostT", "user_name": "Ana", "noise_reduction": "false"})
        self.assertEqual(res.status_code, 200, res.text)
        room._sync_save_to_disk()
        saved = self._load_state()["takes"]
        self.assertEqual(saved["t1000"], old["t1000"])
        self.assertEqual(saved["t3000"], old["t3000"])
        self.assertIn("timing_score", saved["t5000"]["takes"][0])

    def test_noise_reduction_switch_on_old_take(self):
        self._write_old_state()
        room = self._reload()
        with mock.patch.object(audio_processor, "apply_noise_reduction",
                               side_effect=lambda src, dst, *a, **k: shutil.copy2(src, dst)):
            res = self.client.post(f"/api/rooms/{self.ROOM}/lines/t3000/takes/k4/noise_reduction",
                                   json={"noise_reduction": True})
        self.assertEqual(res.status_code, 200, res.text)
        take = room.find_take("t3000", "k4")
        self.assertTrue(take["noise_reduction"])
        self.assertEqual(take["offset_ms"], 0)

    def test_delete_falls_back_to_newest(self):
        self._write_old_state()
        room = self._reload()
        self.assertEqual(room.remove_take("t1000", "k2"), "k3")
        self.assertEqual(rooms.ROOMS[self.ROOM].picked_take("t1000")["offset_ms"], 120)


if __name__ == "__main__":
    unittest.main()
