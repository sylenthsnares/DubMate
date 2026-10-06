# -*- coding: utf-8 -*-
"""
test_effects_rack.py
Voice chains in the room (documentation/design/effects-rack.md, "Settings resolution",
"Data shapes and on-disk layout", "Existing data", "API and WebSocket"): the room's
"voice" and take "chain" on disk, the legacy migration, the loader's version check,
resolution in the mix, the chain and voice routes, level re-matching, timing and level
messages leaving the sound alone, and the render routes (supersede, 503, range
streaming, background preset renders).
"""

import asyncio
import json
import os
import sys
import unittest
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import audio_processor
from dubmate import rooms, rooms_api, vocal_chain
from test_recording_timing import UploadCase, speech_like
from test_take_model import RoomCase

PRESET = {pid: p["chain"] for pid, p in vocal_chain.PRESETS.items()}


def _legacy_take(take_id, number, pitch, reverb):
    """A take as PR #14 (recording timing) saved it."""
    return {"take_id": take_id, "user_id": "hostT", "user_name": "Ana", "duration": 0.25,
            "peaks": [[0.1, 0.2]], "audio_version": 1790000000123, "offset_ms": 40,
            "start_offset_ms": 0, "auto_offset_ms": 40, "aligned": True, "stretch": 1.0,
            "timing_score": 0.8, "pitch_semitones": pitch, "reverb_wet": reverb, "gain_db": -2.0,
            "noise_reduction": False, "has_raw": True, "speech_loudness_db": -18.1,
            "target_loudness_db": -21.3, "auto_gain_db": -3.2, "recorded_at": 1790000000.0,
            "number": number}


class TestRoomLoads(RoomCase):
    """room_state.json from before the rack, from version 1, and from a newer DubMate."""

    def _write_state(self, state):
        with open(self._state_file(), "w", encoding="utf-8") as f:
            json.dump(state, f)

    def _bytes(self):
        return self._read(self._state_file())

    def _v2_state(self):
        takes = {
            "t1000": {"picked": "k1", "next_number": 2, "takes": [_legacy_take("k1", 1, -3.0, 0.4)]},
            "t3000": {"picked": "k2", "next_number": 2, "takes": [_legacy_take("k2", 1, 0.0, 0.3)]},
            "t5000": {"picked": "k3", "next_number": 2, "takes": [_legacy_take("k3", 1, 0.0, 0.0)]},
        }
        for line_id, entry in takes.items():
            take_id = entry["picked"]
            for suffix in ("", "_raw"):
                self._wav(os.path.join(audio_processor.take_dir(self.ROOM, line_id), f"{take_id}{suffix}.wav"), 300)
        return {"state_version": 2, "room_id": self.ROOM, "pack_id": self.PACK_ID, "host_id": "hostT",
                "users": {"hostT": {"id": "hostT", "name": "Host", "color": "#7c5cff",
                                    "is_host": True, "is_online": False}},
                "role_assignments": {"Ana": ["hostT"], "Ben": []},
                "takes": takes, "status": "recording", "exported_video_path": None}

    def test_room_from_before_the_rack_keeps_its_sound(self):
        state = self._v2_state()
        old = json.loads(json.dumps(state["takes"]))
        self._write_state(state)

        room = self._reload()
        chains = {line_id: room.picked_take(line_id).get("chain") for line_id in ("t1000", "t3000", "t5000")}
        self.assertEqual(chains["t1000"], vocal_chain.chain_from_legacy(-3, 0.4))
        self.assertEqual(chains["t3000"], vocal_chain.chain_from_legacy(0, 0.3))
        self.assertIsNone(chains["t5000"])
        nodes = chains["t1000"]["nodes"]
        self.assertEqual((nodes["pitch"]["on"], nodes["pitch"]["semitones"]), (True, -3))
        self.assertEqual((nodes["reverb"]["on"], nodes["reverb"]["mix"], nodes["reverb"]["decay_s"]), (True, 0.4, 1.5))
        self.assertFalse(chains["t3000"]["nodes"]["pitch"]["on"])
        # Every field that was there is unchanged, levels included.
        for line_id, entry in old.items():
            take = dict(room.picked_take(line_id))
            take.pop("chain", None)
            self.assertEqual(take, entry["takes"][0])
        self.assertEqual(room.voice, {"session": None, "characters": {}})

        saved = self._load_state()
        self.assertEqual(saved["state_version"], 2)
        self.assertEqual(sorted(saved["takes"]), ["t1000", "t3000", "t5000"])
        self.assertEqual(saved["takes"], json.loads(json.dumps(room.takes)))
        self.assertEqual(saved["voice"], {"session": None, "characters": {}})

        before = self._bytes()
        again = self._reload()
        self.assertEqual(again.takes, saved["takes"])
        self.assertEqual(self._bytes(), before)

    def test_version_1_room_reaches_the_new_layout_in_one_load(self):
        self._wav(os.path.join(self.room_dir, "take_line_0.wav"), 300)
        old = _legacy_take("ignored", 1, 2.0, 0.1)
        for key in ("take_id", "number", "start_offset_ms", "auto_offset_ms", "aligned", "stretch", "timing_score"):
            old.pop(key)
        state = self._v2_state()
        state.pop("state_version")
        state["takes"] = {"0": old}
        self._write_state(state)

        room = self._reload()
        take = room.picked_take("t1000")
        self.assertEqual(take["take_id"], "take1")
        self.assertEqual(take["chain"], vocal_chain.chain_from_legacy(2, 0.1))
        self.assertEqual((take["pitch_semitones"], take["reverb_wet"], take["gain_db"]), (2.0, 0.1, -2.0))
        saved = self._load_state()
        self.assertEqual((saved["state_version"], saved["voice"]), (2, {"session": None, "characters": {}}))
        self.assertEqual(saved["takes"]["t1000"]["takes"][0]["chain"], take["chain"])

        before = self._bytes()
        self._reload()
        self.assertEqual(self._bytes(), before)

    def test_waiting_version_1_take_gets_its_chain_when_it_moves(self):
        self._wav(os.path.join(self.room_dir, "take_line_0.wav"), 300)
        self._wav(os.path.join(self.room_dir, "take_line_0_raw.wav"), 350)
        old = _legacy_take("ignored", 1, -2.0, 0.0)
        state = self._v2_state()
        state.pop("state_version")
        state["takes"] = {"0": old}
        self._write_state(state)

        real_replace = os.replace
        calls = []

        def flaky_replace(src, dst):
            calls.append(src)
            if len(calls) == 2:
                raise PermissionError(13, "The process cannot access the file", src)
            return real_replace(src, dst)

        with mock.patch.object(audio_processor.os, "replace", flaky_replace):
            room = self._reload()
        self.assertEqual(room.takes, {})
        saved = self._load_state()
        self.assertIn("voice", saved)
        self.assertNotIn("chain", saved["pending_v1_takes"]["0"])  # waits as it was

        room = self._reload()
        self.assertEqual(room.picked_take("t1000")["chain"], vocal_chain.chain_from_legacy(-2, 0))
        self.assertEqual(self._load_state()["takes"]["t1000"]["takes"][0]["chain"], vocal_chain.chain_from_legacy(-2, 0))

    def test_room_from_a_newer_dubmate_is_left_untouched(self):
        state = self._v2_state()
        state["state_version"] = 99
        state["takes"] = {"t1000": {"layout": "something new"}}
        self._write_state(state)
        before = self._bytes()

        rooms.ROOMS.clear()
        rooms.load_persisted_rooms()
        self.assertNotIn(self.ROOM, rooms.ROOMS)
        self.assertEqual(self._bytes(), before)

    def test_room_voice_is_saved_and_restored(self):
        self._write_state(self._v2_state())
        room = self._reload()
        room.voice = {"session": PRESET["radio"], "characters": {"Ana": PRESET["monster"]}}
        room._sync_save_to_disk()
        again = self._reload()
        self.assertEqual(again.voice, {"session": PRESET["radio"], "characters": {"Ana": PRESET["monster"]}})


class TestResolution(RoomCase):
    def test_mix_plays_the_most_specific_chain(self):
        room = self._room()
        self._add(room, "t1000", 300)                                  # Ana, no own chain
        self._add(room, "t3000", 400)                                  # Ben, no own chain
        self._add(room, "t5000", 500, chain=PRESET["warm"])            # Ana, own chain
        room.voice = {"session": PRESET["radio"], "characters": {"Ana": PRESET["monster"]}}

        mix = room.mix_takes()
        self.assertEqual(mix[0]["chain"], PRESET["monster"])
        self.assertEqual(mix[1]["chain"], PRESET["radio"])
        self.assertEqual(mix[2]["chain"], PRESET["warm"])
        self.assertEqual(audio_processor.take_chain(mix[1]), PRESET["radio"])

        room.voice = {"session": None, "characters": {}}
        self.assertEqual(room.mix_takes()[0]["chain"], vocal_chain.CLEAN)

        rendered = []
        with mock.patch.object(audio_processor, "render_take_cached",
                               side_effect=lambda path, chain, *a, **k: rendered.append(chain) or (path, {})):
            audio_processor._render_take(mix[2], audio_processor.SR, 0.0, "test")
        self.assertEqual(rendered, [PRESET["warm"]])

    def test_state_carries_voice_presets_and_take_chains(self):
        room = self._room()
        self._add(room, "t1000", 300, chain=PRESET["warm"])
        state = room.to_state_dict()
        self.assertEqual(state["state_version"], 3)   # the wire version; the saved file stays 2
        self.assertEqual((state["voice"]["session"], state["voice"]["characters"]), (None, {}))
        self.assertEqual([p["id"] for p in state["voice"]["presets"]], ["clean", "warm", "radio", "monster"])
        self.assertEqual(state["voice"]["presets"][2], {"id": "radio", "name": "Radio", "chain": PRESET["radio"]})
        self.assertEqual(state["takes"]["t1000"]["takes"][0]["chain"], PRESET["warm"])
        self.assertNotIn("presets", room.voice)


class RackRoutesCase(UploadCase):
    """A room whose Ana is played by actorA (Ben unassigned), with a matched take on t1000."""

    def _rack_room(self):
        room = self._room()
        room.role_assignments = {"Ana": ["actorA"], "Ben": []}
        self.take = self._upload("t1000", speech_like(duration=2.0, lead=0.3), auto_gain="true")
        return room

    def _render_level(self, take, chain):
        path, _ = audio_processor.render_take_cached(
            audio_processor.take_wav_path(self.ROOM, "t1000", take["take_id"]), chain,
            audio_processor.room_render_dir(self.ROOM))
        return audio_processor.calculate_take_auto_gain(path, target_lufs=take["target_lufs"])

    def _put_chain(self, take_id, chain, user_id="hostT", line_id="t1000"):
        return self.client.put(f"/api/rooms/{self.ROOM}/lines/{line_id}/takes/{take_id}/chain",
                               json={"user_id": user_id, "chain": chain})

    def _put_voice(self, user_id, scope, chain, character=None):
        body = {"user_id": user_id, "scope": scope, "chain": chain}
        if character is not None:
            body["character"] = character
        return self.client.put(f"/api/rooms/{self.ROOM}/voice", json=body)

    def _voice_and_wait(self, room, **body):
        """The voice route called in one event loop, waiting for its background level match."""
        async def go():
            result = await rooms_api.set_room_voice(self.ROOM, body)
            await rooms_api.mix_for_export(room)
            return result
        return asyncio.run(go())


class TestTakeChainRoute(RackRoutesCase):
    def test_only_the_line_actor_or_host_sets_a_take_sound(self):
        room = self._rack_room()
        take_id = self.take["take_id"]
        self.assertEqual(self._put_chain(take_id, PRESET["warm"], user_id="stranger").status_code, 403)
        self.assertNotIn("chain", room.find_take("t1000", take_id))
        for user_id in ("actorA", "hostT"):
            res = self._put_chain(take_id, PRESET["radio"], user_id=user_id)
            self.assertEqual(res.status_code, 200, res.text)
        self.assertEqual(res.json()["take"]["chain"], PRESET["radio"])
        self.assertEqual(res.json()["line"]["takes"][0]["chain"], PRESET["radio"])
        self.assertEqual(self._put_chain(take_id, "loud").status_code, 400)
        self.assertEqual(self._put_chain("nope", PRESET["radio"]).status_code, 404)

    def test_a_matched_take_stays_matched_and_a_set_level_stays(self):
        room = self._rack_room()
        take_id = self.take["take_id"]
        self.assertEqual(self.take["gain_db"], self.take["auto_gain_db"])

        with self.client.websocket_connect(f"/ws/{self.ROOM}/hostT") as ws:
            res = self._put_chain(take_id, PRESET["radio"])
            msg = self._until(ws, "take_params_updated")
        self.assertEqual(res.status_code, 200, res.text)
        self.assertEqual(msg["payload"], {"line_id": "t1000", "take_id": take_id})
        take = room.find_take("t1000", take_id)
        expected = self._render_level(take, PRESET["radio"])
        self.assertNotEqual(expected["auto_gain_db"], self.take["auto_gain_db"])
        self.assertEqual((take["loudness_lufs"], take["auto_gain_db"]), (expected["loudness_lufs"], expected["auto_gain_db"]))
        self.assertEqual(take["gain_db"], expected["auto_gain_db"])

        set_by_hand = expected["auto_gain_db"] + 3.0
        take["gain_db"] = set_by_hand
        self._put_chain(take_id, PRESET["monster"])
        expected = self._render_level(take, PRESET["monster"])
        self.assertEqual(take["auto_gain_db"], expected["auto_gain_db"])
        self.assertEqual(take["gain_db"], set_by_hand)

    def test_clearing_the_chain_follows_the_character_again(self):
        room = self._rack_room()
        room.voice["characters"]["Ana"] = PRESET["monster"]
        take_id = self.take["take_id"]
        self._put_chain(take_id, PRESET["warm"])
        self.assertEqual(room.mix_takes()[0]["chain"], PRESET["warm"])
        res = self._put_chain(take_id, None)
        self.assertEqual(res.status_code, 200, res.text)
        self.assertNotIn("chain", room.find_take("t1000", take_id))
        self.assertEqual(room.mix_takes()[0]["chain"], PRESET["monster"])
        take = room.find_take("t1000", take_id)
        self.assertEqual(take["auto_gain_db"], self._render_level(take, PRESET["monster"])["auto_gain_db"])

    def test_new_take_keeps_the_picked_take_sound(self):
        room = self._rack_room()
        self._put_chain(self.take["take_id"], PRESET["warm"])
        second = self._upload("t1000", speech_like(seed=2, duration=2.0, lead=0.3), auto_gain="true")
        self.assertEqual(second["chain"], PRESET["warm"])
        self.assertEqual(second["auto_gain_db"], self._render_level(second, PRESET["warm"])["auto_gain_db"])
        # A first take on a line follows the room.
        third = self._upload("t3000", speech_like(seed=3, duration=1.0, lead=0.1))
        self.assertNotIn("chain", third)
        self.assertEqual(room.mix_takes()[1]["chain"], vocal_chain.CLEAN)

    def test_take_levelled_without_effects_is_matched_before_export(self):
        room = self._room()
        with mock.patch.object(vocal_chain, "available", return_value=False):
            take = self._upload("t1000", speech_like(duration=2.0, lead=0.3), auto_gain="true")
        self.assertNotIn("loudness_lufs", take)
        old = _legacy_take("old", 1, 0.0, 0.0)
        self._wav(os.path.join(audio_processor.take_dir(self.ROOM, "t3000"), "old.wav"), 300)
        room.takes["t3000"] = {"picked": "old", "next_number": 2, "takes": [dict(old)]}

        mix = asyncio.run(rooms_api.mix_for_export(room))
        stored = room.find_take("t1000", take["take_id"])
        expected = self._render_level(stored, vocal_chain.CLEAN)
        self.assertEqual(stored["loudness_lufs"], expected["loudness_lufs"])
        self.assertEqual((stored["gain_db"], mix[0]["gain_db"]), (expected["auto_gain_db"], expected["auto_gain_db"]))
        # A take from before the rack (no target_lufs) is not re-levelled.
        self.assertEqual(room.find_take("t3000", "old"), old)


class TestVoiceRoute(RackRoutesCase):
    def test_character_sound_permissions(self):
        room = self._rack_room()
        self.assertEqual(self._put_voice("stranger", "character", PRESET["monster"], "Ana").status_code, 403)
        self.assertEqual(room.voice["characters"], {})
        for user_id in ("actorA", "hostT"):
            res = self._put_voice(user_id, "character", PRESET["monster"], "Ana")
            self.assertEqual(res.status_code, 200, res.text)
        # Nobody plays Ben, so anyone may set his sound.
        self.assertEqual(self._put_voice("stranger", "character", PRESET["radio"], "Ben").status_code, 200)
        self.assertEqual(room.voice["characters"], {"Ana": PRESET["monster"], "Ben": PRESET["radio"]})
        self.assertEqual(res.json()["voice"]["characters"]["Ana"], PRESET["monster"])
        self.assertEqual(self._put_voice("hostT", "character", PRESET["radio"], "Ogre").status_code, 400)
        self.assertEqual(self._put_voice("hostT", "everyone", PRESET["radio"]).status_code, 400)
        self.assertEqual(self._put_voice("hostT", "character", None, "Ben").status_code, 200)
        self.assertEqual(room.voice["characters"], {"Ana": PRESET["monster"]})

    def test_every_line_sound_permissions(self):
        room = self._rack_room()
        for user_id in ("stranger", "actorA"):
            self.assertEqual(self._put_voice(user_id, "session", PRESET["radio"]).status_code, 403)
        self.assertIsNone(room.voice["session"])
        self.assertEqual(self._put_voice("hostT", "session", PRESET["radio"]).status_code, 200)
        self.assertEqual(room.voice["session"], PRESET["radio"])
        # In a solo room everyone counts as host.
        room.host_id = "host"
        self.assertEqual(self._put_voice("stranger", "session", None).status_code, 200)
        self.assertIsNone(room.voice["session"])

    def test_character_sound_beats_the_room_sound(self):
        """Session Radio, then Ogre's actor picks Monster for Ogre (here: Ana)."""
        room = self._rack_room()
        ben = self._upload("t3000", speech_like(seed=4, duration=1.0, lead=0.1), auto_gain="true")
        own = self._upload("t5000", speech_like(seed=5, duration=1.0, lead=0.1), auto_gain="true")
        self._put_chain(own["take_id"], PRESET["warm"], line_id="t5000")
        self._put_chain(ben["take_id"], PRESET["warm"], line_id="t3000")

        self._voice_and_wait(room, user_id="hostT", scope="session", chain=PRESET["radio"])
        self._voice_and_wait(room, user_id="actorA", scope="character", character="Ana", chain=PRESET["monster"])

        mix = room.mix_takes()
        self.assertEqual(mix[0]["chain"], PRESET["monster"])    # Ana, followed the room
        self.assertEqual(mix[1]["chain"], PRESET["radio"])      # Ben
        self.assertEqual(mix[2]["chain"], PRESET["monster"])    # Ana, her own sound was cleared
        for line_id in ("t1000", "t3000", "t5000"):
            self.assertNotIn("chain", room.picked_take(line_id))
        # Levels were matched on the new sounds in the background; exports waited for it.
        take = room.picked_take("t1000")
        expected = self._render_level(take, PRESET["monster"])
        self.assertEqual((take["auto_gain_db"], take["gain_db"]), (expected["auto_gain_db"], expected["auto_gain_db"]))
        self.assertEqual(room.rematch_pending, set())

    def test_every_line_clears_character_and_take_sounds(self):
        room = self._rack_room()
        self._put_chain(self.take["take_id"], PRESET["warm"])
        room.voice["characters"] = {"Ana": PRESET["monster"], "Ben": PRESET["warm"]}
        result = self._voice_and_wait(room, user_id="hostT", scope="session", chain=PRESET["radio"])
        self.assertEqual(result["voice"]["characters"], {})
        self.assertEqual(room.voice, {"session": PRESET["radio"], "characters": {}})
        self.assertNotIn("chain", room.picked_take("t1000"))
        self.assertEqual(room.mix_takes()[0]["chain"], PRESET["radio"])
        take = room.picked_take("t1000")
        self.assertEqual(take["auto_gain_db"], self._render_level(take, PRESET["radio"])["auto_gain_db"])


class TestTakeParams(RackRoutesCase):
    """update_take_params carries a take's timing and level only; its sound changes with
    PUT .../chain, and a new take keeps the picked take's sound."""

    def _send(self, ws, **params):
        ws.send_json({"type": "update_take_params",
                      "payload": {"line_id": "t1000", "take_id": self.take["take_id"], **params}})

    def test_pitch_and_reverb_are_ignored(self):
        room = self._rack_room()
        room.voice["characters"]["Ana"] = PRESET["warm"]
        take = room.find_take("t1000", self.take["take_id"])
        with self.client.websocket_connect(f"/ws/{self.ROOM}/hostT") as ws:
            self._send(ws, offset_ms=45, pitch_semitones=-4, reverb_wet=0.35, gain_db=-1.5)
            self._until(ws, "take_params_updated")
        self.assertEqual((take["offset_ms"], take["gain_db"]), (45, -1.5))
        self.assertNotIn("chain", take)
        self.assertNotIn("pitch_semitones", take)
        self.assertNotIn("reverb_wet", take)
        self.assertEqual(room.rematch_pending, set())
        self.assertIsNone(room.voice_job)
        self.assertEqual(room.mix_takes()[0]["chain"], PRESET["warm"])

    def test_a_new_take_keeps_the_picked_sound(self):
        room = self._rack_room()
        legacy = vocal_chain.chain_from_legacy(-3, 0.4)
        room.find_take("t1000", self.take["take_id"]).update(pitch_semitones=-3.0, reverb_wet=0.4, chain=legacy)
        second = self._upload("t1000", speech_like(duration=2.0, lead=0.3))   # the booth sends no slider fields
        take = room.find_take("t1000", second["take_id"])
        self.assertEqual(take["chain"], legacy)
        self.assertNotIn("pitch_semitones", take)


class RenderRoutesCase(RackRoutesCase):
    def _render(self, chain=None, client_id="tabA", **extra):
        body = {"chain": chain if chain is not None else PRESET["warm"], "client_id": client_id, **extra}
        return self.client.post(f"/api/rooms/{self.ROOM}/lines/t1000/takes/{self.take['take_id']}/render",
                                json=body)

    def _fake_render(self, calls):
        """Patches render_take_cached with a fast fake that records (chain, until_s)."""
        def render(wav_path, chain, render_dir, until_s=None, meta=None):
            calls.append((vocal_chain.normalize_chain(chain), until_s))
            return os.path.join(render_dir, "0123456789abcdef.wav"), {"duration": 2.0}
        patcher = mock.patch.object(audio_processor, "render_take_cached", side_effect=render)
        patcher.start()
        self.addCleanup(patcher.stop)


class TestRenderRoute(RenderRoutesCase):
    def test_render_is_served_with_range_support(self):
        self._rack_room()
        res = self._render(PRESET["radio"])
        self.assertEqual(res.status_code, 200, res.text)
        body = res.json()
        self.assertRegex(body["key"], r"^[0-9a-f]{16}$")
        self.assertEqual(body["url"], f"/api/rooms/{self.ROOM}/renders/{body['key']}.wav")
        self.assertIn("lufs", body)
        self.assertAlmostEqual(body["duration"], self.take["duration"], places=2)
        with open(os.path.join(audio_processor.room_render_dir(self.ROOM), body["key"] + ".wav"), "rb") as f:
            data = f.read()

        full = self.client.get(body["url"])
        self.assertEqual(full.status_code, 200)
        self.assertEqual(full.content, data)
        self.assertIn("immutable", full.headers["cache-control"])
        self.assertEqual(full.headers["accept-ranges"], "bytes")

        part = self.client.get(body["url"], headers={"Range": "bytes=10-109"})
        self.assertEqual(part.status_code, 206)
        self.assertEqual(part.content, data[10:110])
        self.assertEqual(part.headers["content-range"], f"bytes 10-109/{len(data)}")

    def test_prefix_render_and_bad_bodies(self):
        self._rack_room()
        body = self._render(until_s=0.5).json()
        self.assertNotIn("lufs", body)
        self.assertAlmostEqual(body["duration"], 0.5, places=2)
        self.assertEqual(self._render(until_s=-1).status_code, 400)
        self.assertEqual(self._render(until_s="soon").status_code, 400)
        self.assertEqual(self._render(chain="warm").status_code, 400)

    def test_bad_keys_and_paths_are_refused(self):
        self._rack_room()
        key = self._render().json()["key"]
        base = f"/api/rooms/{self.ROOM}/renders/"
        for name in ("0123456789abcdef.wav", key.upper() + ".wav", key[:15] + ".wav", key + "0.wav",
                     "..%2F..%2Froom_state.wav", "..%5C..%5Croom_state.wav", "%2E%2E.wav"):
            self.assertIn(self.client.get(base + name).status_code, (400, 404), name)
        self.assertEqual(self.client.get(f"/api/rooms/NOROOM/renders/{key}.wav").status_code, 404)
        self.assertEqual(self.client.post(f"/api/rooms/{self.ROOM}/lines/t1000/takes/nope/render",
                                          json={"chain": PRESET["warm"]}).status_code, 404)

    def test_take_without_its_recording_is_not_found(self):
        self._rack_room()
        os.remove(audio_processor.take_wav_path(self.ROOM, "t1000", self.take["take_id"]))
        res = self._render()
        self.assertEqual(res.status_code, 404, res.text)
        self.assertEqual(res.json()["detail"], "This take's recording is missing.")

    def test_recording_deleted_during_the_render_is_not_found(self):
        self._rack_room()
        wav = audio_processor.take_wav_path(self.ROOM, "t1000", self.take["take_id"])
        kept = wav + ".kept"

        def deleted_while_rendering(*args, **kwargs):
            os.replace(wav, kept)
            raise FileNotFoundError("gone")

        with mock.patch.object(audio_processor, "render_take_cached", side_effect=deleted_while_rendering):
            res = self._render()
        self.assertEqual(res.status_code, 404, res.text)
        self.assertEqual(res.json()["detail"], "This take's recording is missing.")
        os.replace(kept, wav)
        self.assertEqual(self._render().status_code, 200)   # the render slot was freed

    def test_other_missing_files_are_not_a_missing_recording(self):
        # A missing tool (ffmpeg, say) while the recording is still there is a server error,
        # not "recording missing".
        self._rack_room()
        with mock.patch.object(audio_processor, "render_take_cached", side_effect=FileNotFoundError("ffmpeg")):
            with self.assertRaises(FileNotFoundError):
                self._render()
        self.assertEqual(self._render().status_code, 200)   # the render slot was freed

    def test_render_needs_no_permission(self):
        room = self._rack_room()
        self.assertEqual(room.role_assignments["Ana"], ["actorA"])
        self.assertEqual(self._render(client_id="guest-tab").status_code, 200)

    def test_effects_missing_returns_503_with_the_message(self):
        self._rack_room()
        with mock.patch.object(vocal_chain, "available", return_value=False):
            res = self._render()
            self.assertEqual(res.status_code, 503)
            self.assertEqual(res.json(), {"effects_unavailable": True,
                                          "message": "Download and install the latest DubMate to use voice effects."})


class TestSupersede(RenderRoutesCase):
    def test_older_waiting_request_from_the_same_tab_is_superseded(self):
        room = self._rack_room()
        calls = []
        self._fake_render(calls)
        take_id = self.take["take_id"]

        async def go():
            engine = rooms_api._render_engine()
            await engine.foreground.acquire()
            await engine.foreground.acquire()   # both render slots busy

            def request(client_id, chain):
                return asyncio.create_task(rooms_api.render_take(
                    self.ROOM, "t1000", take_id, {"chain": chain, "client_id": client_id}))

            with mock.patch.object(rooms_api, "queue_preset_renders"):
                older = request("tabA", PRESET["warm"])
                await asyncio.sleep(0)
                other = request("tabB", PRESET["clean"])
                await asyncio.sleep(0)
                newer = request("tabA", PRESET["radio"])
                await asyncio.sleep(0)
                self.assertEqual(calls, [])
                engine.foreground.release()
                engine.foreground.release()
                results = await asyncio.gather(older, other, newer)
            self.assertEqual(engine.latest, {})
            self.assertTrue(engine.idle.is_set())
            return results

        older, other, newer = asyncio.run(go())
        self.assertEqual(older.status_code, 409)
        self.assertEqual(json.loads(older.body), {"superseded": True})
        self.assertEqual(other["key"], "0123456789abcdef")
        self.assertEqual(newer["url"], f"/api/rooms/{self.ROOM}/renders/0123456789abcdef.wav")
        self.assertEqual(sorted(json.dumps(c, sort_keys=True) for c, _ in calls),
                         sorted(json.dumps(PRESET[p], sort_keys=True) for p in ("clean", "radio")))
        self.assertIsNotNone(room.find_take("t1000", take_id))


class TestPresetQueue(RenderRoutesCase):
    def test_each_take_is_rendered_through_every_preset_once(self):
        room = self._rack_room()
        take = room.find_take("t1000", self.take["take_id"])
        calls = []
        self._fake_render(calls)

        async def go():
            engine = rooms_api._render_engine()
            engine.idle.clear()   # a foreground render is running: the queue waits
            rooms_api.queue_preset_renders(room, "t1000", take)
            rooms_api.queue_preset_renders(room, "t1000", take)
            await asyncio.sleep(0.05)
            self.assertEqual(calls, [])
            engine.idle.set()
            await engine.worker
            rooms_api.queue_preset_renders(room, "t1000", take)   # already done this run
            self.assertEqual(len(engine.presets), 0)
            for _ in range(2):   # the render route doesn't queue them again either
                result = await rooms_api.render_take(self.ROOM, "t1000", take["take_id"],
                                                     {"chain": PRESET["radio"], "client_id": "tabA"})
                self.assertEqual(result["key"], "0123456789abcdef")
            self.assertEqual(len(engine.presets), 0)
            take["audio_version"] = take["audio_version"] + 1    # new audio: rendered again
            rooms_api.queue_preset_renders(room, "t1000", take)
            await engine.worker

        asyncio.run(go())
        presets = [(p["chain"], None) for p in vocal_chain.PRESETS.values()]
        self.assertEqual(len(presets), 4)
        self.assertEqual(calls, presets + [(PRESET["radio"], None)] * 2 + presets)

    def test_upload_queues_the_presets_after_its_render(self):
        room = self._room()
        queued = []
        with mock.patch.object(rooms_api, "queue_preset_renders",
                               side_effect=lambda r, line_id, take: queued.append((line_id, take["take_id"]))):
            take = self._upload("t1000", speech_like(duration=1.0, lead=0.2))
        self.assertEqual(queued, [("t1000", take["take_id"])])
        self.assertIn("loudness_lufs", room.find_take("t1000", take["take_id"]))


if __name__ == "__main__":
    unittest.main()
