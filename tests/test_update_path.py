# -*- coding: utf-8 -*-
"""
test_update_path.py
A 1.1.3 desktop app that took the in-app update to 2.0 has no pedalboard (voice effects)
and no deep-filter (stronger cleanup): the old updater installs no packages and no
sidecars (documentation/design/v2-update-path.md, section 1). Then videos, stems and
projects save without voice effects (each take at its level, as recorded), cleanup runs on
the fallback, and the engine says what's missing: audio_processor.missing_parts(), /health
"missing" and the room state's "engine_missing".
"""

import contextlib
import io
import json
import os
import shutil
import subprocess
import sys
import tempfile
import textwrap
import unittest
import zipfile
from unittest import mock

import numpy as np

_TESTS_DIR = os.path.dirname(os.path.abspath(__file__))
_ROOT = os.path.dirname(_TESTS_DIR)
sys.path.insert(0, _ROOT)
sys.path.insert(0, _TESTS_DIR)

import audio_processor as ap
import pack_loader
from dubmate import common, rooms, vocal_chain
from test_recording_timing import UploadCase, delayed, speech_like, time_stretched
from test_room_check import white

SR = ap.SR
HOST = "hostT"
WIN_RUNTIME = r"C:\Program Files\DubMate Studio\resources\python-runtime\python.exe"
MAC_RUNTIME = "/Applications/DubMate Studio.app/Contents/Resources/python-runtime/bin/python3"
SOURCE_VENV = "/home/ana/DubMate/.venv/bin/python"
LOOKALIKE = r"C:\tools\python-runtime-old\python.exe"
DRY_LOG = "[Effects] Voice effects aren't installed; videos, stems and projects are saved without them."


def no_effects():
    return mock.patch.object(vocal_chain, "available", return_value=False)


def no_deep_filter():
    return mock.patch.object(ap, "get_deep_filter_path", return_value=None)


def fresh_parts():
    """missing_parts() is worked out once per engine run: this forgets that answer."""
    return mock.patch.object(ap, "_missing_parts", None)


def level(gain_db):
    return np.float32(10.0 ** (float(np.clip(gain_db, ap.GAIN_DB_MIN, ap.GAIN_DB_MAX)) / 20.0))


class TestMissingParts(unittest.TestCase):

    def _parts(self, effects, engine, executable):
        with fresh_parts(), mock.patch.object(vocal_chain, "available", return_value=effects), \
                mock.patch.object(ap, "_noise_reduction_engine", return_value=engine), \
                mock.patch.object(sys, "executable", executable):
            return ap.missing_parts()

    def test_each_combination(self):
        cases = [
            (True, "dfn", WIN_RUNTIME, []),
            (False, "dfn", WIN_RUNTIME, ["voice_effects"]),
            (True, "fallback", WIN_RUNTIME, ["strong_cleanup"]),
            (False, "fallback", WIN_RUNTIME, ["voice_effects", "strong_cleanup"]),
            (False, "fallback", MAC_RUNTIME, ["voice_effects", "strong_cleanup"]),
            # Source installs never had DeepFilterNet, so they aren't told about it.
            (True, "fallback", SOURCE_VENV, []),
            (False, "fallback", SOURCE_VENV, ["voice_effects"]),
            (True, "fallback", LOOKALIKE, []),
        ]
        for effects, engine, exe, expected in cases:
            with self.subTest(effects=effects, engine=engine, exe=exe):
                self.assertEqual(self._parts(effects, engine, exe), expected)

    def test_without_the_binary_the_engine_is_the_fallback(self):
        with fresh_parts(), no_deep_filter(), mock.patch.object(sys, "executable", WIN_RUNTIME), \
                mock.patch.object(vocal_chain, "available", return_value=True):
            self.assertEqual(ap.missing_parts(), ["strong_cleanup"])

    def test_worked_out_once_per_run(self):
        # The room state carries it on every broadcast; only an installer adds these parts,
        # and that restarts the engine.
        with fresh_parts():
            with no_effects(), no_deep_filter(), mock.patch.object(sys, "executable", WIN_RUNTIME):
                first = ap.missing_parts()
            with mock.patch.object(ap, "get_deep_filter_path", side_effect=AssertionError("looked again")), \
                    mock.patch.object(vocal_chain, "available", side_effect=AssertionError("looked again")):
                self.assertEqual(ap.missing_parts(), first)
                ap.missing_parts().append("changed")   # a caller can't change the answer
                self.assertEqual(ap.missing_parts(), ["voice_effects", "strong_cleanup"])

    def test_bundled_runtime(self):
        cases = ((WIN_RUNTIME, True), (MAC_RUNTIME, True), (SOURCE_VENV, False), (LOOKALIKE, False), ("", False))
        for exe, expected in cases:
            with self.subTest(exe=exe), mock.patch.object(sys, "executable", exe):
                self.assertIs(ap.bundled_runtime(), expected)

    def test_the_message_says_where_to_get_it(self):
        self.assertEqual(ap.EFFECTS_MISSING_MESSAGE,
                         "Voice effects need the DubMate 2.0 installer. "
                         "Get it from github.com/sylenthsnares/DubMate/releases.")
        self.assertEqual(str(ap.EffectsUnavailable()), ap.EFFECTS_MISSING_MESSAGE)
        self.assertEqual(common.DOWNLOAD_PAGE_URL, "https://github.com/sylenthsnares/DubMate/releases/latest")


class TestHealthAndRoomState(UploadCase):

    def test_health_lists_what_is_missing(self):
        for parts in ([], ["voice_effects"], ["voice_effects", "strong_cleanup"]):
            with self.subTest(parts=parts), mock.patch.object(ap, "missing_parts", return_value=parts):
                body = self.client.get("/health").json()
                self.assertEqual(body["missing"], parts)
                self.assertEqual(body["status"], "ok")

    def test_health_on_an_updated_desktop_app(self):
        with fresh_parts(), no_effects(), no_deep_filter(), mock.patch.object(sys, "executable", WIN_RUNTIME):
            self.assertEqual(self.client.get("/health").json()["missing"], ["voice_effects", "strong_cleanup"])

    def test_room_state_carries_the_host_engines_list(self):
        room = self._room()
        with fresh_parts(), no_effects(), no_deep_filter(), mock.patch.object(sys, "executable", WIN_RUNTIME):
            self.assertEqual(room.to_state_dict()["engine_missing"], ["voice_effects", "strong_cleanup"])
            self.assertIs(room.to_state_dict()["engine_bundled"], True)
            self.assertEqual(self.client.get(f"/api/rooms/{self.ROOM}").json()["engine_missing"],
                             ["voice_effects", "strong_cleanup"])
        with mock.patch.object(ap, "missing_parts", return_value=[]):
            self.assertEqual(room.to_state_dict()["engine_missing"], [])
        # A source install is told to run its update script, not the installer.
        with mock.patch.object(sys, "executable", SOURCE_VENV):
            self.assertIs(room.to_state_dict()["engine_bundled"], False)


class TestDryRenderTake(unittest.TestCase):
    """_render_take without voice effects: the take's own audio times its clamped level."""

    def setUp(self):
        self.dir = tempfile.mkdtemp(prefix="dm_dry_take_")
        self.addCleanup(shutil.rmtree, self.dir, True)
        self.raw = speech_like(duration=1.0, lead=0.1)
        self.wav = os.path.join(self.dir, "take.wav")
        ap.write_wav_mono(self.wav, self.raw, SR)
        self.raw = ap.read_wav_mono(self.wav, SR)
        patcher = mock.patch.object(ap, "_dry_takes_logged", False)
        patcher.start()
        self.addCleanup(patcher.stop)

    def _take(self):
        return {"wav_path": self.wav, "render_dir": os.path.join(self.dir, "renders"),
                "chain": vocal_chain.PRESETS["warm"]["chain"]}

    def test_dry_take_is_the_raw_audio_at_its_level(self):
        out = io.StringIO()
        with no_effects(), contextlib.redirect_stdout(out):
            for gain in (-4.5, 0.0, 40.0):
                with self.subTest(gain_db=gain):
                    audio = ap._render_take(self._take(), SR, gain, "test")
                    np.testing.assert_array_equal(audio, self.raw * level(gain))
        self.assertFalse(os.path.exists(os.path.join(self.dir, "renders")))
        self.assertEqual(out.getvalue().count(DRY_LOG), 1)

    def test_logged_once_per_run(self):
        out = io.StringIO()
        with no_effects(), contextlib.redirect_stdout(out):
            for _ in range(3):
                ap._render_take(self._take(), SR, 0.0, "a")
                ap._render_take(self._take(), SR, 0.0, "b")
        self.assertEqual(out.getvalue().count(DRY_LOG), 1)
        self.assertNotIn("WARNING", out.getvalue())

    def test_render_cache_still_refuses(self):
        with no_effects(), self.assertRaises(ap.EffectsUnavailable):
            ap.render_take_cached(self.wav, vocal_chain.CLEAN, os.path.join(self.dir, "renders"))


class DryRoomCase(UploadCase):
    """A room with two takes at their levels, exported without voice effects."""

    def setUp(self):
        super().setUp()
        self.exports = tempfile.mkdtemp(prefix="dm_dry_exports_")
        self.addCleanup(shutil.rmtree, self.exports, True)
        for patcher in (mock.patch.object(common, "_exports_dir", self.exports),
                        mock.patch.object(ap, "_dry_takes_logged", False)):
            patcher.start()
            self.addCleanup(patcher.stop)
        self.room = self._room()
        self._add(self.room, "t1000", 300, offset_ms=40, gain_db=-3.0,
                  chain=vocal_chain.PRESETS["monster"]["chain"])
        self._add(self.room, "t3000", 400, gain_db=2.5)

    def _raw(self, line_id, take_id):
        return ap.read_wav_mono(ap.take_wav_path(self.ROOM, line_id, take_id), SR)

    def _expected_voices(self):
        """The dialogue bus built by hand: each take's own audio x its level at its offset,
        and the original voice of the unrecorded line."""
        voices = np.zeros(ap._timeline_samples(self.pack, SR), dtype=np.float32)
        for line_id, take_id, gain, offset in (("t1000", "k300", -3.0, 40), ("t3000", "k400", 2.5, 0)):
            line = self.room.find_line(line_id)
            ap._mix_into([voices], self._raw(line_id, take_id) * level(gain), line["start"] + offset / 1000.0, SR)
        line = self.room.find_line("t5000")
        original = ap.read_wav_mono(os.path.join(self.pack.folder, line["filename"]), SR)
        ap._mix_into([voices], original * np.float32(ap.ORIGINAL_LINE_LEVEL), line["start"], SR)
        return voices


class TestDryExports(DryRoomCase):

    def test_stems_are_the_raw_takes_at_their_level(self):
        out = os.path.join(self.exports, "stems.zip")
        with no_effects(), contextlib.redirect_stdout(io.StringIO()):
            ap.build_stems_zip(self.pack, self.room.mix_takes(), out, room_id=self.ROOM)
        with zipfile.ZipFile(out) as zf:
            name = next(n for n in zf.namelist() if n.endswith("/Dialogue.wav"))
            path = os.path.join(self.exports, "Dialogue.wav")
            with open(path, "wb") as fh:
                fh.write(zf.read(name))
        dialogue = ap.read_wav_mono(path, SR)
        voices = self._expected_voices()
        g = np.float32(10.0 ** (ap._master_gain_db(ap.integrated_lufs(voices, SR)) / 20.0))
        np.testing.assert_allclose(dialogue, voices * g, atol=1e-6)
        self.assertTrue(np.any(dialogue))

    def test_project_zip_says_no_effects(self):
        written = {}
        real_mp3 = ap.write_mp3_mono

        def capture(path, data, *args, **kwargs):
            written[os.path.basename(path)] = np.array(data, copy=True)
            return real_mp3(path, data, *args, **kwargs)

        out = os.path.join(self.exports, "project.zip")
        with no_effects(), mock.patch.object(ap, "write_mp3_mono", side_effect=capture), \
                contextlib.redirect_stdout(io.StringIO()):
            ap.build_project_zip(self.pack, self.room.mix_takes(), output_zip_path=out, room_id=self.ROOM)
        with zipfile.ZipFile(out) as zf:
            manifest = json.loads(zf.read(next(n for n in zf.namelist() if n.endswith("project_manifest.json"))))
            cues = zf.read(next(n for n in zf.namelist() if n.endswith("Timeline_Cues.txt"))).decode("utf-8")
        self.assertEqual(manifest["version"], "2.3")
        self.assertIs(manifest["master"]["voice_effects"], False)
        self.assertEqual(cues.count("| Sound: none (voice effects not installed) |"), 2)
        self.assertNotIn("Sound: Monster", cues)
        line_one = next(v for k, v in written.items() if k.startswith("Line_01_"))
        np.testing.assert_array_equal(line_one, self._raw("t1000", "k300") * level(-3.0))

    @unittest.skipUnless(vocal_chain.available(), "pedalboard is not installed")
    def test_project_zip_with_effects_says_so(self):
        out = os.path.join(self.exports, "project.zip")
        with contextlib.redirect_stdout(io.StringIO()):
            ap.build_project_zip(self.pack, self.room.mix_takes(), output_zip_path=out, room_id=self.ROOM)
        with zipfile.ZipFile(out) as zf:
            manifest = json.loads(zf.read(next(n for n in zf.namelist() if n.endswith("project_manifest.json"))))
            cues = zf.read(next(n for n in zf.namelist() if n.endswith("Timeline_Cues.txt"))).decode("utf-8")
        self.assertIs(manifest["master"]["voice_effects"], True)
        self.assertIn("| Sound: Monster |", cues)

    def test_video_is_saved_without_effects(self):
        packs = pack_loader.get_all_packs()
        pack = next((p for p in packs.values() if p.video_path), None)
        self.assertIsNotNone(pack, "fixture packs missing: run scripts/make_test_packs.py")
        rendered = []
        real = ap._render_take

        def spy(*args, **kwargs):
            rendered.append(real(*args, **kwargs))
            return rendered[-1]

        takes = {0: {"wav_path": ap.take_wav_path(self.ROOM, "t1000", "k300"), "render_dir": ap.room_render_dir(self.ROOM),
                     "offset_ms": 0, "gain_db": -3.0, "chain": vocal_chain.PRESETS["warm"]["chain"]}}
        out = os.path.join(self.exports, "dub.mp4")
        with no_effects(), mock.patch.object(ap, "_render_take", side_effect=spy), \
                contextlib.redirect_stdout(io.StringIO()):
            ap.export_dub_video(pack, takes, out)
        self.assertGreater(os.path.getsize(out), 10000)
        self.assertEqual(len(rendered), 1)
        np.testing.assert_array_equal(rendered[0], self._raw("t1000", "k300") * level(-3.0))


class TestDryRoutes(DryRoomCase):

    def test_stems_and_project_routes_save(self):
        with no_effects(), contextlib.redirect_stdout(io.StringIO()):
            stems = self.client.get(f"/api/rooms/{self.ROOM}/export/stems?user_id={HOST}")
            project = self.client.get(f"/api/rooms/{self.ROOM}/export/project_zip?user_id={HOST}")
        self.assertEqual(stems.status_code, 200, stems.text)
        self.assertEqual(project.status_code, 200, project.text)
        self.assertEqual(stems.headers["content-type"], "application/zip")
        with zipfile.ZipFile(io.BytesIO(project.content)) as zf:
            manifest = json.loads(zf.read(next(n for n in zf.namelist() if n.endswith("project_manifest.json"))))
        self.assertIs(manifest["master"]["voice_effects"], False)
        self.assertNotIn("stems", self.room.export_status)

    def test_render_route_still_refuses_so_the_booth_plays_the_take(self):
        with no_effects():
            res = self.client.post(f"/api/rooms/{self.ROOM}/lines/t1000/takes/k300/render",
                                   json={"chain": vocal_chain.CLEAN})
        self.assertEqual(res.status_code, 503)
        self.assertEqual(res.json(), {"effects_unavailable": True, "message": ap.EFFECTS_MISSING_MESSAGE})


class TestWithoutDeepFilter(UploadCase):
    """Without deep-filter every cleanup path runs on the fallback denoiser."""

    def setUp(self):
        super().setUp()
        patcher = no_deep_filter()
        patcher.start()
        self.addCleanup(patcher.stop)
        self.room = self._room()

    def _take(self):
        return self.room.picked_take("t1000")

    def test_upload_with_cleanup_and_the_toggle(self):
        self._upload("t1000", speech_like(duration=1.5, lead=0.2) + white(-45.0, seconds=1.5)[:int(1.5 * SR)],
                     noise_reduction="true")
        take = self._take()
        self.assertTrue(take["noise_reduction"])
        take_dir = ap.take_dir(self.ROOM, "t1000")
        self.assertTrue(os.path.isfile(ap.denoised_take_path(take_dir, take["take_id"])))
        url = f"/api/rooms/{self.ROOM}/lines/t1000/takes/{take['take_id']}/noise_reduction"
        off = self.client.post(url, json={"noise_reduction": False})
        self.assertEqual(off.status_code, 200, off.text)
        self.assertFalse(self._take()["noise_reduction"])
        on = self.client.post(url, json={"noise_reduction": True})
        self.assertEqual(on.status_code, 200, on.text)
        self.assertTrue(self._take()["noise_reduction"])

    def test_room_check_and_refresh_older_takes(self):
        check = self.client.post("/api/noise_profiles", data={"device_id": "dev1"},
                                 files={"file": ("check.wav", self._wav_bytes(white(-50.0, seconds=3.3)), "audio/wav")})
        self.assertEqual(check.status_code, 200, check.text)
        pid = check.json()["profile_id"]
        self.assertTrue(pid)
        self._one_event_loop(self.client)
        self._upload("t1000", speech_like(duration=1.5, lead=0.2), noise_reduction="true")
        take = self._take()
        res = self.client.post(f"/api/rooms/{self.ROOM}/cleanup/refresh",
                               json={"user_id": HOST, "noise_profile_id": pid})
        self.assertEqual(res.status_code, 200, res.text)
        task = self.room.cleanup_refresh_task
        if task is not None:
            import asyncio
            import functools
            self.client.portal.call(functools.partial(asyncio.wait, {task}, timeout=30))
            self.assertTrue(task.done())
            self.assertIsNone(task.exception())
        self.assertEqual(self._take()["nr_settings"], ap.noise_cleanup_settings(pid))
        self.assertTrue(os.path.isfile(ap.denoised_take_path(ap.take_dir(self.ROOM, "t1000"), take["take_id"],
                                                             ap.noise_cleanup_settings(pid))))

    def _wav_bytes(self, audio):
        path = os.path.join(self.cache, "check.wav")
        ap.write_wav_mono(path, audio, SR)
        with open(path, "rb") as f:
            return f.read()


class TestTakesWithNeither(UploadCase):
    """An updated 1.1.3 app has neither part: a fitted, cleaned take is recorded, set back to
    its original speed, given a sound and saved, and its level stays the one measured on it."""

    def test_take_routes_and_save(self):
        room = self._room()
        with no_effects(), no_deep_filter(), contextlib.redirect_stdout(io.StringIO()):
            self._upload("t1000", delayed(time_stretched(self.ref, 1.06), 60), noise_reduction="true", auto_gain="true")
            take = room.picked_take("t1000")
            self.assertNotEqual(take["stretch"], 1.0)
            self.assertNotIn("loudness_lufs", take)
            base = f"/api/rooms/{self.ROOM}/lines/t1000/takes/{take['take_id']}"
            res = self.client.post(base + "/original_speed", json={"user_id": HOST})
            self.assertEqual(res.status_code, 200, res.text)
            self.assertEqual(take["stretch"], 1.0)
            res = self.client.put(base + "/chain", json={"user_id": HOST, "chain": vocal_chain.PRESETS["radio"]["chain"]})
            self.assertEqual(res.status_code, 200, res.text)
            self.assertEqual(take["gain_db"], take["auto_gain_db"])
            self.assertNotIn("loudness_lufs", take)
            stems = self.client.get(f"/api/rooms/{self.ROOM}/export/stems?user_id={HOST}")
            self.assertEqual(stems.status_code, 200, stems.text)


class TestWithoutPedalboardInstalled(unittest.TestCase):
    """A real engine process where `import pedalboard` fails, as on the 1.1.3 runtime."""

    def test_stems_zip_on_a_fixture_pack(self):
        work = tempfile.mkdtemp(prefix="dm_no_pedalboard_")
        self.addCleanup(shutil.rmtree, work, True)
        script = textwrap.dedent(f"""
            import json, os, sys, zipfile
            sys.modules["pedalboard"] = None
            sys.path.insert(0, {_ROOT!r})
            import numpy as np
            import audio_processor as ap, pack_loader
            from dubmate import vocal_chain
            assert not vocal_chain.available()
            pack = next(p for p in sorted(pack_loader.get_all_packs().values(), key=lambda p: p.pack_id) if p.lines)
            take = os.path.join({work!r}, "take.wav")
            t = np.arange(ap.SR) / ap.SR
            ap.write_wav_mono(take, (0.2 * np.sin(2 * np.pi * 220 * t)).astype(np.float32), ap.SR)
            takes = {{0: {{"wav_path": take, "render_dir": os.path.join({work!r}, "renders"), "offset_ms": 0,
                         "gain_db": -2.0, "chain": vocal_chain.PRESETS["radio"]["chain"]}}}}
            out = ap.build_stems_zip(pack, takes, os.path.join({work!r}, "stems.zip"), room_id="NOPB")
            with zipfile.ZipFile(out) as zf:
                print(json.dumps(sorted(n.split("/", 1)[1] for n in zf.namelist())))
        """)
        # Its own cache (pack_index.json and the rest), also when this file runs on its own
        # rather than under run_all_tests; the packs still come from the configured folders.
        env = dict(os.environ, DUBMATE_CACHE_DIR=os.path.join(work, "cache"))
        res = subprocess.run([sys.executable, "-c", script], capture_output=True, text=True, timeout=300, env=env)
        self.assertEqual(res.returncode, 0, res.stderr + res.stdout)
        names = json.loads(res.stdout.strip().splitlines()[-1])
        self.assertIn("Dialogue.wav", names)
        self.assertIn("Music_and_Effects.wav", names)
        self.assertEqual(res.stdout.count(DRY_LOG), 1)


if __name__ == "__main__":
    unittest.main()
