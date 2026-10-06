"""Take timing: alignment math (audio_processor.align_take_timing) on synthetic signals,
auto-aligned offsets on upload, fitted (stretched) takes and Original speed, the best-timed
delete fallback, and rooms saved before it."""
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
import zipfile
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


class UploadCase(TimingRoomCase):
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


class TestAlignedUpload(UploadCase):
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


class TestWriteActiveTake(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp(prefix="dm_active_take_")
        self.addCleanup(shutil.rmtree, self.dir, True)
        self.source = os.path.join(self.dir, "k1_raw.wav")
        self.target = os.path.join(self.dir, "k1.wav")
        audio_processor.write_wav_mono(self.source, speech_like(duration=2.0), SR)

    def _bytes(self, path):
        with open(path, "rb") as f:
            return f.read()

    def test_plain_copy_at_one(self):
        audio_processor._write_active_take(self.source, self.target, 1.0004)
        self.assertEqual(self._bytes(self.target), self._bytes(self.source))
        self.assertEqual(sorted(os.listdir(self.dir)), ["k1.wav", "k1_raw.wav"])

    def test_stretch_shortens(self):
        audio_processor._write_active_take(self.source, self.target, 1.06)
        n_src = len(audio_processor.read_wav_mono(self.source))
        n_out = len(audio_processor.read_wav_mono(self.target))
        # atempo also drops about 20 ms at the head.
        self.assertAlmostEqual(n_out / n_src, 1 / 1.06, delta=0.02)
        self.assertEqual(sorted(os.listdir(self.dir)), ["k1.wav", "k1_raw.wav"])

    def test_failed_pass_keeps_previous_audio(self):
        audio_processor._write_active_take(self.source, self.target, 1.0)
        before = self._bytes(self.target)

        def half_written(src, dst, *a, **k):
            with open(dst, "wb") as f:
                f.write(b"partial")
            raise subprocess.CalledProcessError(1, "ffmpeg")

        with mock.patch.object(audio_processor, "_ffmpeg_to_mono_wav", side_effect=half_written):
            with self.assertRaises(subprocess.CalledProcessError):
                audio_processor._write_active_take(self.source, self.target, 1.06)
        self.assertEqual(self._bytes(self.target), before)
        self.assertEqual(sorted(os.listdir(self.dir)), ["k1.wav", "k1_raw.wav"])


def _fake_denoise(src, dst, *a, **k):
    shutil.copy2(src, dst)
    return dst


class TestFittedTakes(UploadCase):
    def _slow_take(self):
        return delayed(time_stretched(self.ref, 1.06), 60)

    def _files(self, take):
        d = audio_processor.take_dir(self.ROOM, "t1000")
        return os.path.join(d, f"{take['take_id']}.wav"), os.path.join(d, f"{take['take_id']}_raw.wav")

    def _samples(self, path):
        return len(audio_processor.read_wav_mono(path))

    def _original_speed(self, take_id, user_id="hostT", line_id="t1000"):
        return self.client.post(f"/api/rooms/{self.ROOM}/lines/{line_id}/takes/{take_id}/original_speed",
                                json={"user_id": user_id})

    def test_slow_take_is_fitted(self):
        room = self._room()
        slow = self._slow_take()
        wire = self._upload("t1000", slow)
        take = room.picked_take("t1000")
        active, raw = self._files(take)
        self.assertNotEqual(take["stretch"], 1.0)
        self.assertLessEqual(abs(take["stretch"] - 1.06), 0.01)
        self.assertTrue(take["aligned"])
        self.assertEqual(take["offset_ms"] % 5, 0)
        self.assertEqual(wire["stretch"], take["stretch"])
        self.assertEqual(self._samples(raw), len(slow))
        self.assertLess(take["duration"], len(slow) / SR)
        self.assertAlmostEqual(self._samples(active) / len(slow), 1 / take["stretch"], delta=0.02)
        self.assertAlmostEqual(take["duration"], self._samples(active) / SR, places=3)
        # The offset lines up the file as written, not an ideal stretch of it.
        on_file = align_take_timing(audio_processor.read_wav_mono(active), self.ref, 0, allow_stretch=False)
        self.assertLessEqual(abs(take["auto_offset_ms"] - on_file["auto_offset_ms"]), 5)
        self.assertNotIn(f"{take['take_id']}.tmp.wav", os.listdir(os.path.dirname(active)))

    def test_noise_reduction_switch_keeps_the_fit(self):
        room = self._room()
        self._upload("t1000", self._slow_take())
        take = room.picked_take("t1000")
        active, raw = self._files(take)
        fitted_len = self._samples(active)
        timing = {f: take[f] for f in TIMING_FIELDS + ("offset_ms",)}
        with mock.patch.object(audio_processor, "apply_noise_reduction", side_effect=_fake_denoise):
            for enable in (True, False):
                res = self.client.post(f"/api/rooms/{self.ROOM}/lines/t1000/takes/{take['take_id']}/noise_reduction",
                                       json={"noise_reduction": enable})
                self.assertEqual(res.status_code, 200, res.text)
                self.assertLessEqual(abs(self._samples(active) - fitted_len), SR // 100)
        self.assertEqual({f: take[f] for f in timing}, timing)

    def test_original_speed_restores_recorded_speed(self):
        room = self._room()
        slow = self._slow_take()
        self._upload("t1000", slow, gain_db=0.0, auto_gain="true")
        take = room.picked_take("t1000")
        active, raw = self._files(take)
        fitted_auto = take["auto_offset_ms"]
        room.exported_video_path = "old.mp4"
        version = take["audio_version"]
        with self.client.websocket_connect(f"/ws/{self.ROOM}/hostT") as ws:
            res = self._original_speed(take["take_id"])
            msg = self._until(ws, "take_params_updated")
        self.assertEqual(res.status_code, 200, res.text)
        self.assertEqual(take["stretch"], 1.0)
        self.assertEqual(self._samples(active), len(slow))
        self.assertAlmostEqual(take["duration"], len(slow) / SR, places=3)
        self.assertEqual(take["auto_offset_ms"] % 5, 0)
        self.assertEqual(take["offset_ms"], take["auto_offset_ms"])
        self.assertNotEqual(take["auto_offset_ms"], fitted_auto)
        self.assertGreater(take["audio_version"], version)
        self.assertEqual(take["gain_db"], take["auto_gain_db"])
        self.assertIsNone(room.exported_video_path)
        self.assertEqual(res.json()["take"]["stretch"], 1.0)
        self.assertEqual(msg["payload"], {"line_id": "t1000", "take_id": take["take_id"],
                                          "url": res.json()["take"]["url"]})

    def test_original_speed_keeps_a_nudged_offset(self):
        room = self._room()
        self._upload("t1000", self._slow_take())
        take = room.picked_take("t1000")
        take["offset_ms"] = take["auto_offset_ms"] + 40
        nudged = take["offset_ms"]
        res = self._original_speed(take["take_id"])
        self.assertEqual(res.status_code, 200, res.text)
        self.assertEqual(take["stretch"], 1.0)
        self.assertEqual(take["offset_ms"], nudged)

    def test_original_speed_on_unfitted_take_changes_nothing(self):
        room = self._room()
        self._upload("t1000", delayed(self.ref, 140))
        take = room.picked_take("t1000")
        before = dict(take)
        room.exported_video_path = "old.mp4"
        res = self._original_speed(take["take_id"])
        self.assertEqual(res.status_code, 200, res.text)
        self.assertEqual(res.json()["take"]["take_id"], take["take_id"])
        self.assertEqual(take, before)
        self.assertEqual(room.exported_video_path, "old.mp4")

    def test_original_speed_guards(self):
        room = self._room()
        self._upload("t1000", self._slow_take())
        take = room.picked_take("t1000")
        room.role_assignments["Ana"] = ["actorA"]
        self.assertEqual(self._original_speed(take["take_id"], user_id="otherU").status_code, 403)
        self.assertNotEqual(take["stretch"], 1.0)
        self.assertEqual(self._original_speed("nope1234").status_code, 404)
        self.assertEqual(self._original_speed(take["take_id"], line_id="t9999").status_code, 404)
        self.assertEqual(self._original_speed(take["take_id"], user_id="actorA").status_code, 200)
        self.assertEqual(take["stretch"], 1.0)

    def test_project_zip_manifest_has_stretch(self):
        room = self._room()
        self._upload("t1000", self._slow_take())
        stretch = room.picked_take("t1000")["stretch"]
        zip_out = os.path.join(self.cache, "project.zip")
        audio_processor.build_project_zip(self.pack, room.mix_takes(), output_zip_path=zip_out, room_id=self.ROOM)
        with zipfile.ZipFile(zip_out) as zf:
            name = next(n for n in zf.namelist() if n.endswith("project_manifest.json"))
            manifest = json.loads(zf.read(name))
        lines = {l["line_id"]: l for l in manifest["lines"]}
        self.assertEqual(lines["t1000"]["stretch"], stretch)
        self.assertEqual(lines["t3000"]["stretch"], 1.0)


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
