# -*- coding: utf-8 -*-
"""
test_v1_migration.py
Rooms saved by DubMate 1.1.3 (documentation/design/v2-update-path.md section 4): the
room_state.json backup, original take files kept, and a take never placed on a line it
might not belong to. The room in tests/fixtures/v113_room/ was saved by the real 1.1.3
code (tests/fixtures/make_v113_room.py).
"""

import builtins
import contextlib
import io
import json
import os
import shutil
import sys
import unittest
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import audio_processor
from dubmate import rooms
from test_take_model import RoomCase

FIXTURE_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "fixtures", "v113_room")
with open(os.path.join(FIXTURE_DIR, "room_state.json"), "rb") as _f:
    FIXTURE_STATE_BYTES = _f.read()
FIXTURE_STATE = json.loads(FIXTURE_STATE_BYTES.decode("utf-8"))
RECORDED_AT = min(t["recorded_at"] for t in FIXTURE_STATE["takes"].values())
BACKUP_NAME = "room_state.v1-backup.json"


class V113RoomCase(RoomCase):
    """The 1.1.3 room copied into a fresh cache, on a pack with the same lines
    (make_v113_room.LINES), its files dated an hour before the takes were recorded."""

    ROOM = FIXTURE_STATE["room_id"]
    PACK_ID = FIXTURE_STATE["pack_id"]
    LINES = ((1.0, "Ana", "01_Ana_1-000.wav"), (3.25, "Ben", "02_Ben_3-250.wav"), (5.5, "Ana", "03_Ana_5-500.wav"))

    def setUp(self):
        super().setUp()
        for name in os.listdir(FIXTURE_DIR):
            shutil.copyfile(os.path.join(FIXTURE_DIR, name), os.path.join(self.room_dir, name))
        self.originals = {name: self._read(os.path.join(self.room_dir, name))
                          for name in os.listdir(self.room_dir) if name.endswith(".wav")}
        self._date_pack(RECORDED_AT - 3600)

    def _make_pack(self):
        folder = os.path.join(self.cache, "pack")
        os.makedirs(folder)
        pack = rooms.pack_loader.PackInfo(self.PACK_ID, folder, "V113 Fixture Pack")
        pack.characters = ["Ana", "Ben"]
        pack.duration = 7.0
        for i, (start, char, fname) in enumerate(self.LINES):
            self._wav(os.path.join(folder, fname), 200 + 40 * i)
            pack.lines.append({"index": i, "start": start, "end": start + 0.4, "character": char,
                               "filename": fname, "caption": f"Line {i + 1}"})
        rooms.pack_loader.assign_line_ids(pack.lines)  # t1000, t3250, t5500
        return pack

    def _date_pack(self, mtime, folder_mtime=None):
        for line in self.pack.lines:
            os.utime(os.path.join(self.pack.folder, line["filename"]), (mtime, mtime))
        folder_mtime = mtime if folder_mtime is None else folder_mtime
        os.utime(self.pack.folder, (folder_mtime, folder_mtime))

    def _insert_line(self, at, start, fname, mtime):
        """Edits the pack as a rebuild after recording would: a new line file at index `at`."""
        self._wav(os.path.join(self.pack.folder, fname), 600)
        os.utime(os.path.join(self.pack.folder, fname), (mtime, mtime))
        self.pack.lines.insert(at, {"start": start, "end": start + 0.4, "character": "Ben",
                                    "filename": fname, "caption": "New line"})
        for i, line in enumerate(self.pack.lines):
            line["index"] = i
        rooms.pack_loader.assign_line_ids(self.pack.lines)

    def _write_state(self, state):
        with open(self._state_file(), "w", encoding="utf-8") as f:
            json.dump(state, f, indent=2)

    def _backup_file(self):
        return os.path.join(self.room_dir, BACKUP_NAME)

    def _snapshot(self):
        out = {}
        for root, _, files in os.walk(self.room_dir):
            for name in files:
                path = os.path.join(root, name)
                out[os.path.relpath(path, self.room_dir)] = self._read(path)
        return out

    def _reload_logged(self):
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            room = self._reload()
        return room, out.getvalue()

    def _assert_originals_kept(self):
        for name, data in self.originals.items():
            self.assertEqual(self._read(os.path.join(self.room_dir, name)), data, name)


class TestV113Room(V113RoomCase):
    def test_room_loads_with_takes_on_their_lines(self):
        room = self._reload()
        self.assertEqual(sorted(room.takes), ["t1000", "t5500"])
        self.assertEqual(room.unplaced_v1_takes, {})
        for line_id, old in (("t1000", FIXTURE_STATE["takes"]["0"]), ("t5500", FIXTURE_STATE["takes"]["2"])):
            take = room.picked_take(line_id)
            self.assertEqual((take["take_id"], take["number"]), ("take1", 1))
            for key in ("user_id", "user_name", "duration", "offset_ms", "gain_db", "auto_gain_db",
                        "speech_loudness_db", "target_loudness_db", "recorded_at", "has_raw"):
                self.assertEqual(take[key], old[key], key)
            self.assertNotIn("wav_path", take)
        self.assertTrue(room.picked_take("t1000")["noise_reduction"])
        self.assertFalse(room.picked_take("t5500")["noise_reduction"])
        saved = self._load_state()
        self.assertEqual(saved["state_version"], rooms.STATE_VERSION)
        self.assertNotIn("unplaced_v1_takes", saved)

    def test_backup_is_byte_identical_to_the_original(self):
        self._reload()
        self.assertEqual(self._read(self._backup_file()), FIXTURE_STATE_BYTES)
        self.assertNotEqual(self._read(self._state_file()), FIXTURE_STATE_BYTES)

    def test_original_take_files_are_kept_and_copied_byte_identically(self):
        self._reload()
        self._assert_originals_kept()
        for line_id, index in (("t1000", 0), ("t5500", 2)):
            d = os.path.join(self.room_dir, "takes", line_id)
            for suffix in ("", "_raw", "_denoised"):
                old = self.originals.get(f"take_line_{index}{suffix}.wav")
                if old is not None:
                    self.assertEqual(self._read(os.path.join(d, f"take1{suffix}.wav")), old)
            self.assertFalse([n for n in os.listdir(d) if not n.endswith(".wav")])

    def test_existing_backup_is_not_overwritten(self):
        with open(self._backup_file(), "wb") as f:
            f.write(b"an earlier backup")
        self._reload()
        self.assertEqual(self._read(self._backup_file()), b"an earlier backup")

    def test_failed_backup_means_no_save_until_it_works(self):
        real_open = builtins.open

        def no_backup(path, *args, **kwargs):
            if BACKUP_NAME in os.fspath(path):
                raise PermissionError(13, "Access is denied", path)
            return real_open(path, *args, **kwargs)

        with mock.patch.object(rooms, "open", no_backup, create=True):
            room, log = self._reload_logged()
            self.assertEqual(sorted(room.takes), ["t1000", "t5500"])  # usable in memory
            room._sync_save_to_disk()  # a save later in the session waits too
        self.assertIn("backup", log.lower())
        self.assertEqual(self._read(self._state_file()), FIXTURE_STATE_BYTES)
        self.assertEqual([n for n in os.listdir(self.room_dir) if "backup" in n], [])

        room = self._reload()
        self.assertEqual(self._read(self._backup_file()), FIXTURE_STATE_BYTES)
        self.assertEqual(self._load_state()["state_version"], rooms.STATE_VERSION)
        self.assertEqual(sorted(room.takes), ["t1000", "t5500"])

    def test_rerun_after_a_crash_before_saving_is_idempotent(self):
        with mock.patch.object(rooms.Room, "_sync_save_to_disk", lambda self: None):
            self._reload()
        self.assertEqual(self._read(self._state_file()), FIXTURE_STATE_BYTES)
        room = self._reload()
        self.assertEqual(sorted(room.takes), ["t1000", "t5500"])
        self.assertEqual([len(e["takes"]) for e in room.takes.values()], [1, 1])
        self._assert_originals_kept()
        before = self._snapshot()
        again = self._reload()
        self.assertEqual(again.takes, room.takes)
        self.assertEqual(self._snapshot(), before)


class TestTakesNeverOnAWrongLine(V113RoomCase):
    def test_line_inserted_after_recording_keeps_later_takes_aside(self):
        # A rebuilt pack: a new line at index 1, written after the takes. The folder time is
        # left old so the line-file rule alone decides.
        self._insert_line(1, 2.0, "02_Ben_2-000.wav", RECORDED_AT + 600)
        self._date_pack(RECORDED_AT - 3600)
        os.utime(os.path.join(self.pack.folder, "02_Ben_2-000.wav"), (RECORDED_AT + 600,) * 2)
        room, log = self._reload_logged()

        self.assertEqual(sorted(room.takes), ["t1000"])  # index 0 is before the insert
        self.assertEqual(room.unplaced_v1_takes, {"2": FIXTURE_STATE["takes"]["2"]})
        self.assertIn("take for old line 3 kept aside: the scene changed after it was recorded", log)
        self.assertFalse(os.path.exists(os.path.join(self.room_dir, "takes", "t3250")))
        self.assertFalse(os.path.exists(os.path.join(self.room_dir, "takes", "t5500")))
        self._assert_originals_kept()
        self.assertEqual(self._load_state()["unplaced_v1_takes"], {"2": FIXTURE_STATE["takes"]["2"]})

    def test_newer_pack_folder_keeps_every_take_aside(self):
        self._date_pack(RECORDED_AT - 3600, folder_mtime=RECORDED_AT + 600)  # a line file removed
        room = self._reload()
        self.assertEqual(room.takes, {})
        self.assertEqual(sorted(room.unplaced_v1_takes), ["0", "2"])
        self.assertFalse(os.path.exists(os.path.join(self.room_dir, "takes")) and
                         any(os.listdir(os.path.join(self.room_dir, "takes"))))
        self._assert_originals_kept()

    def test_a_couple_of_seconds_of_clock_slack_still_places(self):
        self._date_pack(RECORDED_AT + 1.5)
        room = self._reload()
        self.assertEqual(sorted(room.takes), ["t1000", "t5500"])

    def test_missing_or_unreadable_recorded_at_keeps_the_take_aside(self):
        state = json.loads(FIXTURE_STATE_BYTES)
        del state["takes"]["0"]["recorded_at"]
        state["takes"]["2"]["recorded_at"] = "yesterday"
        self._write_state(state)
        room = self._reload()
        self.assertEqual(room.takes, {})
        self.assertEqual(sorted(room.unplaced_v1_takes), ["0", "2"])
        self._assert_originals_kept()

    def test_missing_line_file_keeps_the_take_aside(self):
        os.remove(os.path.join(self.pack.folder, "01_Ana_1-000.wav"))
        os.utime(self.pack.folder, (RECORDED_AT - 3600,) * 2)
        room = self._reload()
        self.assertEqual(room.takes, {})

    def test_take_outside_the_scene_is_kept_aside(self):
        state = json.loads(FIXTURE_STATE_BYTES)
        state["takes"]["7"] = state["takes"].pop("2")
        self._write_state(state)
        room = self._reload()
        self.assertEqual(sorted(room.takes), ["t1000"])
        self.assertEqual(sorted(room.unplaced_v1_takes), ["7"])

    def test_kept_aside_takes_survive_saves_and_reloads(self):
        self._date_pack(RECORDED_AT - 3600, folder_mtime=RECORDED_AT + 600)
        room = self._reload()
        unplaced = json.loads(json.dumps(room.unplaced_v1_takes))
        self.assertNotIn("unplaced_v1_takes", room.to_state_dict())
        self._add(room, "t3250", 500)
        room._sync_save_to_disk()
        self.assertEqual(self._load_state()["unplaced_v1_takes"], unplaced)

        room = self._reload()
        self.assertEqual(room.unplaced_v1_takes, unplaced)
        self.assertEqual(sorted(room.takes), ["t3250"])
        room._sync_save_to_disk()
        self.assertEqual(self._load_state()["unplaced_v1_takes"], unplaced)
        self._assert_originals_kept()

    def test_room_with_only_kept_aside_takes_stays_listed(self):
        """Listed sessions are the ones pruning keeps; these takes must not be pruned away."""
        self._date_pack(RECORDED_AT - 3600, folder_mtime=RECORDED_AT + 600)
        room = self._reload()
        self.assertEqual(room.takes, {})
        self.assertTrue(rooms._summary_from_room(room)["listed"])
        rooms.ROOMS.clear()
        self.assertTrue(rooms._summary_from_folder(self.ROOM, self.room_dir)["listed"])


if __name__ == "__main__":
    unittest.main()
