# -*- coding: utf-8 -*-
"""
test_room_identity.py
Who you are in a room: one 8-hue palette read from static/js/identity.js, colours
unique per room (pick_color, with the 9th-person rule), names cut to 24 characters,
old saved colours still loading, auto-cast on a first join in the lobby, guests
claiming or giving back a free character, and the host's Cast evenly.
"""

import json
import os
import unittest

import sys as _sys
_TESTS_DIR = os.path.dirname(os.path.abspath(__file__))
_sys.path.insert(0, os.path.dirname(_TESTS_DIR))
_sys.path.insert(0, _TESTS_DIR)

from fastapi.testclient import TestClient

import pack_loader
from app import app
from dubmate import common, identity, rooms
from test_security_hardening import _barrier
from test_take_model import RoomCase

CORAL, LIME, MINT, CORNFLOWER = "#f08a6c", "#b5cf5a", "#6fd3a8", "#7d9cf0"
ORCHID, PINK, CYAN, BLUSH = "#d987d9", "#ec4899", "#06b6d4", "#e9a3b8"
PALETTE = [CORAL, LIME, MINT, CORNFLOWER, ORCHID, PINK, CYAN, BLUSH]
HOST = "hostT"


def _identity_js():
    with open(os.path.join(common.find_static_dir(), "js", "identity.js"), "r", encoding="utf-8") as f:
        return f.read().replace("\r\n", "\n")


class TestPalette(unittest.TestCase):

    def test_palette_is_read_from_identity_js(self):
        self.assertEqual([hex_ for _, hex_ in identity.IDENTITY_COLORS], PALETTE)
        self.assertEqual([name for name, _ in identity.IDENTITY_COLORS],
                         ["Coral", "Lime", "Mint", "Cornflower", "Orchid", "Pink", "Cyan", "Blush"])

    def test_legacy_table(self):
        expected = {
            "#d97706": CORAL, "#dc2626": CORAL, "#b45309": CORAL, "#f59e0b": CORAL,
            "#cca458": LIME, "#16a34a": MINT, "#25d3a4": MINT,
            "#7c5cff": CORNFLOWER, "#8a6eff": CORNFLOWER, "#8b5cf6": ORCHID,
            "#ec4899": PINK, "#06b6d4": CYAN,
        }
        self.assertEqual(identity.LEGACY_COLORS, expected)

    def test_parser_refuses_anything_but_eight_hues(self):
        text = _identity_js()
        self.assertEqual(len(identity.parse_identity_js(text)[0]), 8)
        seven = text.replace("  { name: 'Blush', hex: '#e9a3b8' },\n", "")
        self.assertNotEqual(seven, text, "the Blush entry is not in the pinned format")
        with self.assertRaises(ValueError):
            identity.parse_identity_js(seven)
        odd = text.replace("{ name: 'Lime', hex: '#b5cf5a' }", "{ name: 'Lime', hex: 'lime' }")
        with self.assertRaises(ValueError):
            identity.parse_identity_js(odd)

    def test_no_signal_colour_in_the_palette(self):
        # The record red, the done green and the amber stay signal colours.
        for signal in ("#d97706", "#dc2626", "#16a34a", "#ef4444", "#22c55e", "#f59e0b"):
            self.assertNotIn(signal, PALETTE)

    def test_normalize_color(self):
        self.assertEqual(identity.normalize_color("#F08A6C"), CORAL)
        self.assertEqual(identity.normalize_color(" #b5cf5a "), LIME)
        self.assertEqual(identity.normalize_color("#d97706"), CORAL)
        self.assertEqual(identity.normalize_color("#7C5CFF"), CORNFLOWER)
        for junk in ("#123abc", "#abc", "red", "", None, 7, "#12", "url(x)", "#f08a6c;background:red"):
            self.assertEqual(identity.normalize_color(junk), "", junk)

    def test_clean_name(self):
        self.assertEqual(identity.clean_name("  Tani \t  Ra \n"), "Tani Ra")
        self.assertEqual(identity.clean_name("x" * 30), "x" * 24)
        self.assertEqual(identity.clean_name("a" * 23 + " bcd"), "a" * 23)
        self.assertEqual(identity.clean_name(None), "")
        self.assertEqual(identity.clean_name(42), "")
        self.assertEqual(identity.NAME_MAX, 24)


class IdentityRoomCase(RoomCase):
    """A 4-character pack: Mika 1 line, Old Man 3, Courier 2, Kid 2 (in that pack order)."""

    ROOM = "IDROOM"
    PACK_ID = "identity_pack"

    def _make_pack(self):
        folder = os.path.join(self.cache, "pack")
        os.makedirs(folder)
        pack = pack_loader.PackInfo(self.PACK_ID, folder, "Identity Pack")
        pack.characters = ["Mika", "Old Man", "Courier", "Kid"]
        pack.duration = 20.0
        order = ["Old Man", "Mika", "Courier", "Old Man", "Kid", "Courier", "Old Man", "Kid"]
        for i, char in enumerate(order):
            pack.lines.append({"index": i, "start": 1.0 + 2 * i, "end": 2.5 + 2 * i, "character": char,
                               "filename": f"{i:02d}.wav", "caption": f"Line {i + 1}"})
        pack_loader.assign_line_ids(pack.lines)
        return pack

    def setUp(self):
        super().setUp()
        self.client = TestClient(app)

    def _room(self):
        room = rooms.Room(self.ROOM, self.pack, HOST, "Tani", CORAL)
        rooms.ROOMS[self.ROOM] = room
        return room

    def _user(self, room, uid, name, color, online=True):
        room.users[uid] = {"id": uid, "name": name, "color": color, "is_host": False, "is_online": online}

    def _join(self, ws, name, color=CORAL):
        ws.send_json({"type": "join", "payload": {"name": name, "color": color}})

    def _frames(self, ws):
        ws.send_json({"type": "ping", "payload": {}})
        frames = []
        for _ in range(60):
            frame = ws.receive_json()
            if frame.get("type") == "pong":
                return frames
            frames.append(frame)
        raise AssertionError("no pong")

    def _joined(self, frames, uid):
        found = [f for f in frames if f.get("type") == "user_joined" and f["payload"]["user_id"] == uid]
        self.assertEqual(len(found), 1, frames)
        return found[0]["payload"]


class TestPickColor(IdentityRoomCase):

    def test_empty_room(self):
        self.assertEqual(identity.pick_color(None, LIME, "a"), LIME)
        self.assertEqual(identity.pick_color(None, None, "a"), CORAL)
        self.assertEqual(identity.pick_color(None, "#d97706", "a"), CORAL, "a legacy colour is mapped")
        self.assertEqual(identity.pick_color(None, "#123abc", "a"), CORAL, "an unknown hex gets the first hue")
        self.assertEqual(identity.pick_color(None, "javascript:x", "a"), CORAL)

    def test_wanted_free_and_taken(self):
        room = self._room()  # Tani holds Coral
        self.assertEqual(identity.pick_color(room, MINT, "a"), MINT)
        self.assertEqual(identity.pick_color(room, CORAL, "a"), LIME)
        self.assertEqual(identity.pick_color(room, "#dc2626", "a"), LIME, "legacy Red is Coral, which is taken")

    def test_offline_holders_count_while_hues_are_free(self):
        room = self._room()
        self._user(room, "b", "Bea", LIME, online=False)
        self.assertEqual(identity.pick_color(room, LIME, "a"), MINT)

    def test_restored_legacy_colours_count_as_their_hue(self):
        room = self._room()
        self._user(room, "b", "Bea", "#7c5cff", online=False)
        self.assertEqual(identity.pick_color(room, CORNFLOWER, "a"), LIME)

    def test_ninth_person(self):
        room = self._room()  # Tani: Coral, online
        for i, hex_ in enumerate(PALETTE[1:]):
            self._user(room, f"u{i}", f"P{i}", hex_, online=(hex_ != CYAN))
        # All 8 held: an offline holder no longer counts, so Cyan (offline) is free.
        self.assertEqual(identity.pick_color(room, CORAL, "new"), CYAN)
        # Wanted held only by an offline person: wanted wins.
        self.assertEqual(identity.pick_color(room, CYAN, "new"), CYAN)
        # Everyone online: the hue with the fewest online holders, earliest in the palette.
        room.users["u5"]["is_online"] = True
        self.assertEqual(identity.pick_color(room, MINT, "new"), CORAL)
        self._user(room, "ninth", "Nina", CORAL)
        self.assertEqual(identity.pick_color(room, CORAL, "tenth"), LIME)

    def test_rejoin_keeps_the_room_colour(self):
        room = self._room()
        self._user(room, "b", "Bea", MINT, online=False)
        self.assertEqual(identity.pick_color(room, CORAL, "b"), MINT)
        self.assertEqual(identity.pick_color(room, PINK, "b"), MINT)
        # Taken meanwhile by someone online: the usual rule.
        self._user(room, "c", "Cy", MINT)
        self.assertEqual(identity.pick_color(room, PINK, "b"), PINK)
        self.assertEqual(identity.pick_color(room, MINT, "b"), LIME)

    def test_rejoin_with_a_legacy_room_colour(self):
        room = self._room()
        self._user(room, "b", "Bea", "#25d3a4", online=False)
        self.assertEqual(identity.pick_color(room, PINK, "b"), MINT)


class TestNamesAndColoursOnTheWire(IdentityRoomCase):

    def test_create_room_caps_the_name_and_normalizes_the_colour(self):
        res = self.client.post("/api/rooms", json={"pack_id": self.PACK_ID, "host_name": "  Tani " + "x" * 30,
                                                   "host_color": "#d97706"})
        self.assertEqual(res.status_code, 200, res.text)
        data = res.json()
        host = data["state"]["users"][data["user_id"]]
        self.assertEqual(host["name"], ("Tani " + "x" * 30)[:24])
        self.assertEqual(host["color"], CORAL)
        res = self.client.post("/api/rooms", json={"pack_id": self.PACK_ID, "host_name": "   ",
                                                   "host_color": "expression(alert(1))"})
        data = res.json()
        host = data["state"]["users"][data["user_id"]]
        self.assertEqual(host["name"], "Host")
        self.assertEqual(host["color"], CORAL)

    def test_creator_gets_the_character_with_the_most_lines(self):
        res = self.client.post("/api/rooms", json={"pack_id": self.PACK_ID, "host_name": "Tani", "host_color": LIME})
        data = res.json()
        cast = data["state"]["role_assignments"]
        self.assertEqual(cast["Old Man"], [data["user_id"]])
        self.assertEqual([c for c, ids in cast.items() if ids], ["Old Man"])

    def test_join_caps_the_name_and_reports_the_colour(self):
        room = self._room()
        with self.client.websocket_connect(f"/ws/{self.ROOM}/{HOST}") as host_ws:
            self._join(host_ws, "Tani", CORAL)
            _barrier(host_ws)
            with self.client.websocket_connect(f"/ws/{self.ROOM}/m1") as ws:
                self._join(ws, "  Sam   " + "y" * 40, CORAL)
                payload = self._joined(self._frames(ws), "m1")
                self.assertEqual(room.users["m1"]["name"], ("Sam " + "y" * 40)[:24])
                self.assertEqual(payload["color"], LIME)
                self.assertEqual(payload["wanted_color"], CORAL)
                self.assertEqual(room.users["m1"]["color"], LIME)
                self.assertEqual(payload["cast"], "Courier")
                self.assertEqual(set(payload), {"user_id", "color", "wanted_color", "cast"})

                with self.client.websocket_connect(f"/ws/{self.ROOM}/m2") as ws2:
                    self._join(ws2, "", "#ff0000")
                    payload = self._joined(self._frames(ws2), "m2")
                    self.assertEqual(room.users["m2"]["name"], "Actor")
                    self.assertEqual(payload["wanted_color"], "")
                    self.assertEqual(payload["color"], MINT)
        self.assertEqual(room.users[HOST]["color"], CORAL)

    def test_the_host_keeps_their_colour_on_their_own_join(self):
        room = self._room()
        with self.client.websocket_connect(f"/ws/{self.ROOM}/{HOST}") as ws:
            self._join(ws, "Tani", PINK)
            payload = self._joined(self._frames(ws), HOST)
            self.assertEqual(payload["color"], CORAL)
            self.assertIsNone(payload["cast"])
        self.assertEqual(room.role_assignments["Old Man"], [HOST])

    def test_restored_room_with_old_colours_loads_intact(self):
        users = {
            HOST: {"id": HOST, "name": "Tani", "color": "#7c5cff", "is_host": True, "is_online": True},
            "m1": {"id": "m1", "name": "Mika", "color": "#25d3a4", "is_host": False, "is_online": True},
            "m2": {"id": "m2", "name": "Sam", "color": "#d97706", "is_host": False, "is_online": False},
            "m3": {"id": "m3", "name": "Odd", "color": "#123456", "is_host": False, "is_online": False},
        }
        os.makedirs(self.room_dir, exist_ok=True)
        with open(self._state_file(), "w", encoding="utf-8") as f:
            json.dump({"state_version": rooms.STATE_VERSION, "room_id": self.ROOM, "pack_id": self.PACK_ID,
                       "host_id": HOST, "users": users,
                       "role_assignments": {"Mika": ["m1"], "Old Man": [HOST], "Courier": ["m2"], "Kid": []},
                       "takes": {}, "status": "recording"}, f)
        room = rooms.load_room_folder(self.ROOM)
        self.assertIsNotNone(room)
        self.assertEqual(set(room.users), set(users))
        for uid, user in users.items():
            self.assertEqual(room.users[uid]["name"], user["name"])
            self.assertEqual(room.users[uid]["color"], user["color"], "a stored colour was rewritten on load")
            self.assertFalse(room.users[uid]["is_online"])
        self.assertEqual(room.role_assignments["Courier"], ["m2"])

        # Joining again maps the old colour to its hue; nobody is cast on a rejoin.
        room.status = "lobby"
        with self.client.websocket_connect(f"/ws/{self.ROOM}/m2") as ws:
            self._join(ws, "Sam", "#d97706")
            payload = self._joined(self._frames(ws), "m2")
            self.assertEqual(payload["color"], CORAL)
            self.assertIsNone(payload["cast"])
        self.assertEqual(room.role_assignments["Kid"], [])


class TestAutoCast(IdentityRoomCase):

    def test_first_joins_in_the_lobby(self):
        room = self._room()
        self.assertEqual(room.role_assignments["Old Man"], [HOST], "the creator gets the most lines, not characters[0]")
        with self.client.websocket_connect(f"/ws/{self.ROOM}/{HOST}") as host_ws:
            self._join(host_ws, "Tani")
            _barrier(host_ws)
            casts = []
            for uid in ("m1", "m2", "m3", "m4"):
                with self.client.websocket_connect(f"/ws/{self.ROOM}/{uid}") as ws:
                    self._join(ws, uid)
                    casts.append(self._joined(self._frames(ws), uid)["cast"])
            # Courier and Kid both have 2 lines: pack order breaks the tie.
            self.assertEqual(casts, ["Courier", "Kid", "Mika", None])
        self.assertEqual(room.role_assignments,
                         {"Mika": ["m3"], "Old Man": [HOST], "Courier": ["m1"], "Kid": ["m2"]})

    def test_no_auto_cast_on_a_rejoin(self):
        room = self._room()
        with self.client.websocket_connect(f"/ws/{self.ROOM}/m1") as ws:
            self._join(ws, "Sam")
            _barrier(ws)
        room.role_assignments["Courier"] = []
        with self.client.websocket_connect(f"/ws/{self.ROOM}/m1") as ws:
            self._join(ws, "Sam")
            self.assertIsNone(self._joined(self._frames(ws), "m1")["cast"])
        self.assertEqual(room.role_assignments["Courier"], [])

    def test_no_auto_cast_outside_the_lobby(self):
        room = self._room()
        for status in ("recording", "screening"):
            room.status = status
            uid = f"late_{status}"
            with self.client.websocket_connect(f"/ws/{self.ROOM}/{uid}") as ws:
                self._join(ws, "Late")
                self.assertIsNone(self._joined(self._frames(ws), uid)["cast"])
        self.assertEqual([c for c, ids in room.role_assignments.items() if ids], ["Old Man"])


class TestGuestCasting(IdentityRoomCase):

    def _assign(self, ws, character, user_ids):
        ws.send_json({"type": "assign_role", "payload": {"character": character, "user_ids": user_ids}})
        return self._frames(ws)

    def _errors(self, frames):
        return [f["payload"]["message"] for f in frames if f.get("type") == "error"]

    def test_claim_and_give_back(self):
        room = self._room()
        with self.client.websocket_connect(f"/ws/{self.ROOM}/{HOST}") as host_ws:
            self._join(host_ws, "Tani")
            _barrier(host_ws)
            with self.client.websocket_connect(f"/ws/{self.ROOM}/m1") as ws:
                self._join(ws, "Sam")
                _barrier(ws)
                self.assertEqual(room.role_assignments["Courier"], ["m1"])
                frames = self._assign(ws, "Kid", ["m1"])
                self.assertEqual(self._errors(frames), [])
                self.assertTrue(any(f.get("type") == "role_assigned" for f in frames))
                self.assertEqual(room.role_assignments["Kid"], ["m1"])
                frames = self._assign(ws, "Courier", [])
                self.assertEqual(self._errors(frames), [])
                self.assertEqual(room.role_assignments["Courier"], [])

    def test_refusals(self):
        room = self._room()
        with self.client.websocket_connect(f"/ws/{self.ROOM}/{HOST}") as host_ws:
            self._join(host_ws, "Tani")
            _barrier(host_ws)
            with self.client.websocket_connect(f"/ws/{self.ROOM}/m1") as ws:
                self._join(ws, "Sam")
                _barrier(ws)
                before = json.loads(json.dumps(room.role_assignments))

                self.assertEqual(self._errors(self._assign(ws, "Old Man", ["m1"])), ["Tani is voicing Old Man now."])
                self.assertEqual(len(self._errors(self._assign(ws, "Kid", [HOST]))), 1, "cast someone else")
                self.assertEqual(len(self._errors(self._assign(ws, "Kid", ["m1", HOST]))), 1, "several ids")
                self.assertEqual(len(self._errors(self._assign(ws, "Old Man", []))), 1, "give back someone else's")
                self.assertEqual(len(self._errors(self._assign(ws, "Kid", "m1"))), 1, "not a list")
                self.assertEqual(room.role_assignments, before)

                # A character the host gave to two people, the guest among them, stays the host's call.
                room.role_assignments["Mika"] = ["m1", HOST]
                self.assertEqual(len(self._errors(self._assign(ws, "Mika", []))), 1)
                self.assertEqual(room.role_assignments["Mika"], ["m1", HOST])

    def test_the_host_still_casts_anyone(self):
        room = self._room()
        with self.client.websocket_connect(f"/ws/{self.ROOM}/{HOST}") as host_ws:
            self._join(host_ws, "Tani")
            _barrier(host_ws)
            with self.client.websocket_connect(f"/ws/{self.ROOM}/m1") as ws:
                self._join(ws, "Sam")
                _barrier(ws)
                errors = self._errors(self._assign(host_ws, "Old Man", ["m1", HOST]))
                self.assertEqual(errors, [])
                self.assertEqual(room.role_assignments["Old Man"], ["m1", HOST])


class TestCastEvenly(IdentityRoomCase):

    def test_host_only(self):
        room = self._room()
        with self.client.websocket_connect(f"/ws/{self.ROOM}/{HOST}") as host_ws:
            self._join(host_ws, "Tani")
            _barrier(host_ws)
            with self.client.websocket_connect(f"/ws/{self.ROOM}/m1") as ws:
                self._join(ws, "Sam")
                _barrier(ws)
                before = json.loads(json.dumps(room.role_assignments))
                ws.send_json({"type": "cast_evenly", "payload": {}})
                frames = self._frames(ws)
                self.assertTrue(any(f.get("type") == "error" for f in frames), frames)
                self.assertEqual(room.role_assignments, before)

    def test_the_deal(self):
        room = self._room()
        self._user(room, "gone", "Gone", PINK, online=False)
        with self.client.websocket_connect(f"/ws/{self.ROOM}/{HOST}") as host_ws:
            self._join(host_ws, "Tani")
            _barrier(host_ws)
            with self.client.websocket_connect(f"/ws/{self.ROOM}/m1") as ws1, \
                    self.client.websocket_connect(f"/ws/{self.ROOM}/m2") as ws2:
                self._join(ws1, "Sam")
                _barrier(ws1)
                self._join(ws2, "Bea")
                _barrier(ws2)
                host_ws.send_json({"type": "cast_evenly", "payload": {}})
                frames = self._frames(host_ws)
                self.assertTrue(any(f.get("type") == "cast_evenly" for f in frames), frames)
        # Most lines first, each to whoever has the fewest lines so far (host first, then join order):
        # Old Man (3) -> Tani, Courier (2) -> Sam, Kid (2) -> Bea, Mika (1) -> Sam (2 lines vs Bea's 2: Sam joined first).
        self.assertEqual(room.role_assignments,
                         {"Old Man": [HOST], "Courier": ["m1"], "Kid": ["m2"], "Mika": ["m1"]})


if __name__ == "__main__":
    unittest.main()
