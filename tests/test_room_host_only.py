# -*- coding: utf-8 -*-
"""
test_room_host_only.py
Only the host moves the whole room: a guest's set_status is refused with a plain
error on their own socket and the room stays where it was. A room still held by the
placeholder "host" lets anyone move it, as assign_role does.
"""

import os
import sys
import unittest

_TESTS_DIR = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(_TESTS_DIR))
sys.path.insert(0, _TESTS_DIR)

from test_recording_timing import UploadCase


class TestSetStatusHostOnly(UploadCase):
    def setUp(self):
        super().setUp()
        self.room = self._room()  # host_id == "hostT"
        self.room.users["guestG"] = {"id": "guestG", "name": "Mika", "color": "#25d3a4",
                                     "is_host": False, "is_online": True}

    def _set_status(self, ws, status):
        ws.send_json({"type": "set_status", "payload": {"status": status}})

    def _replies(self, ws, status):
        """Everything this socket gets for one set_status, up to a marker that always comes
        back (a ready change), so a missing refusal fails instead of hanging."""
        self._set_status(ws, status)
        ws.send_json({"type": "set_user_status", "payload": {"is_ready": False}})
        got = []
        while (msg := ws.receive_json())["type"] != "user_status_updated":
            got.append(msg)
        return got

    def test_guest_is_refused_and_room_stays(self):
        before = self.room.status
        with self.client.websocket_connect(f"/ws/{self.ROOM}/guestG") as ws:
            for status, message in (("recording", "Only the host can start recording."),
                                    ("screening", "Only the host can do that."),
                                    ("lobby", "Only the host can do that.")):
                got = self._replies(ws, status)
                self.assertNotIn("status_changed", [m["type"] for m in got])
                errors = [m for m in got if m["type"] == "error"]
                self.assertEqual(len(errors), 1, got)
                self.assertEqual(errors[0]["payload"], {"message": message})
        self.assertEqual(self.room.status, before)

    def test_host_moves_the_room(self):
        with self.client.websocket_connect(f"/ws/{self.ROOM}/hostT") as ws:
            self._set_status(ws, "recording")
            msg = self._until(ws, "status_changed")
        self.assertEqual(msg["payload"], {"status": "recording"})
        self.assertEqual(msg["state"]["status"], "recording")
        self.assertEqual(self.room.status, "recording")

    def test_placeholder_host_lets_anyone(self):
        self.room.host_id = "host"
        with self.client.websocket_connect(f"/ws/{self.ROOM}/guestG") as ws:
            self._set_status(ws, "recording")
            msg = self._until(ws, "status_changed")
        self.assertEqual(msg["payload"], {"status": "recording"})
        self.assertEqual(self.room.status, "recording")


if __name__ == "__main__":
    unittest.main()
