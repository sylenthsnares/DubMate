# -*- coding: utf-8 -*-
"""
dubmate/room_ws.py
Room WebSocket (/ws/{room_id}/{user_id}): presence, roles, mode, takes,
premiere and screening sync.

Works on the room model in dubmate.rooms and never imports app.
"""

import json
import asyncio
import traceback

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

import audio_processor
from dubmate import identity, rooms, rooms_api

router = APIRouter()


def _is_host(room, user_id: str) -> bool:
    """The room's host; in a solo room (host_id "host") everyone counts as host."""
    return user_id == room.host_id or room.host_id == "host"


async def _refuse(websocket: WebSocket, message: str) -> None:
    await websocket.send_json({"type": "error", "payload": {"message": message}})


def _guest_cast_refusal(room, user_id: str, character, user_ids) -> str:
    """Why a member who isn't the host can't make this casting change, or "" when they
    can: claiming a character nobody voices (user_ids == [themselves]) or giving back
    one only they voice (user_ids == []). Repeating either is harmless."""
    current = room.role_assignments.get(character) if isinstance(character, str) else None
    if current is None:
        return "That character isn't in this scene."
    if user_ids in ([user_id], []) and current in ([], [user_id]):
        return ""
    if user_ids in ([user_id], []) and user_id not in current:
        holder = room.users.get(current[0], {}).get("name") or "Someone"
        return f"{holder} is voicing {character} now."
    return f"Only the host can change who voices {character}."


async def _wait_for_cleanup_refresh(room) -> None:
    """Returns once no Refresh older takes is running or about to start its task (a request
    still planning holds its claim in room.cleanup_refreshing before the task exists)."""
    while True:
        task = room.cleanup_refresh_task
        if task is not None and not task.done():
            await asyncio.wait({task})
        elif room.cleanup_refreshing:
            await asyncio.sleep(0.05)
        else:
            return


@router.websocket("/ws/{room_id}/{user_id}")
async def websocket_endpoint(websocket: WebSocket, room_id: str, user_id: str):
    await websocket.accept()
    room = rooms.ROOMS.get(room_id.upper())

    if not room:
        await websocket.send_text(json.dumps({"type": "error", "message": "Room not found"}))
        await websocket.close()
        return

    room.sockets.add(websocket)
    if user_id in room.users:
        room.users[user_id]["is_online"] = True
    await room.broadcast("user_connected", {"user_id": user_id})

    try:
        while True:
            raw = await websocket.receive_text()
            try:
                data = json.loads(raw)
                msg_type = data.get("type")
                payload = data.get("payload", {})
            except Exception as ex:
                print(f"[WS] {room_id}/{user_id} ignored malformed message: {ex!r}")
                continue

            if msg_type == "join":
                name = identity.clean_name(payload.get("name")) or "Actor"
                wanted = payload.get("color")
                color = identity.pick_color(room, wanted, user_id)
                wanted_hex = identity.normalize_color(wanted)
                # Only when someone else holds the hue you asked for; a rejoin may simply keep your room colour.
                wanted_taken_by = identity.holder_name(room, wanted_hex, user_id) if wanted_hex != color else ""
                first_join = user_id not in room.users

                # Auto-promote user to host if previous host is dummy "host" or offline
                active_host = room.users.get(room.host_id)
                if room.host_id == "host" or not active_host or not active_host.get("is_online", False):
                    room.host_id = user_id

                room.users[user_id] = {
                    "id": user_id,
                    "name": name,
                    "color": color,
                    "is_host": (user_id == room.host_id),
                    "is_online": True,
                }
                # Sync is_host flag for all users
                for uid, u in room.users.items():
                    u["is_host"] = (uid == room.host_id)

                # A newcomer to a room still casting voices the free character with the most lines.
                cast = room.free_character_with_most_lines() if first_join and room.status == "lobby" else None
                if cast:
                    room.role_assignments[cast] = [user_id]

                await room.broadcast("user_joined", {
                    "user_id": user_id,
                    "color": color,
                    "wanted_color": wanted_hex,
                    "wanted_taken_by": wanted_taken_by,
                    "cast": cast,
                })

            elif msg_type == "assign_role":
                character = payload.get("character")
                assigned_user_ids = payload.get("user_ids", [])
                if not _is_host(room, user_id):
                    refusal = _guest_cast_refusal(room, user_id, character, assigned_user_ids)
                    if refusal:
                        await _refuse(websocket, refusal)
                        continue
                valid = (isinstance(character, str) and isinstance(assigned_user_ids, list)
                         and all(isinstance(uid, str) for uid in assigned_user_ids))
                if valid and character in room.role_assignments:
                    room.role_assignments[character] = assigned_user_ids
                    await room.broadcast("role_assigned", {"character": character, "user_ids": assigned_user_ids})

            elif msg_type == "cast_evenly":
                if not _is_host(room, user_id):
                    await _refuse(websocket, "Only the host can recast everyone.")
                    continue
                room.cast_evenly()
                await room.broadcast("cast_evenly", {"triggered_by": user_id})

            elif msg_type == "set_status":
                # Moves everyone; a member's own place is set_user_status.
                if not _is_host(room, user_id):
                    await _refuse(websocket, "Only the host can move the room.")
                    continue
                new_status = payload.get("status", "lobby")
                if new_status in ("lobby", "recording", "screening"):
                    room.status = new_status
                    await room.broadcast("status_changed", {"status": new_status})

            elif msg_type == "update_take_params":
                line_id = payload.get("line_id")
                take_id = payload.get("take_id")
                take = room.find_take(line_id, take_id) if isinstance(line_id, str) else None
                if take:
                    # Timing and level only; the take's sound changes with PUT .../chain.
                    for key in ("offset_ms", "gain_db"):
                        if key in payload:
                            take[key] = payload[key]
                    room.invalidate_exports()
                    await room.broadcast("take_params_updated", {"line_id": line_id, "take_id": take_id})

            elif msg_type == "set_user_status":
                if user_id in room.users:
                    if "current_line" in payload:
                        room.users[user_id]["current_line"] = payload["current_line"]
                    if "location" in payload:
                        room.users[user_id]["location"] = payload["location"]
                    if "is_ready" in payload:
                        room.users[user_id]["is_ready"] = payload["is_ready"]
                    await room.broadcast("user_status_updated", {
                        "user_id": user_id,
                        "user": room.users[user_id]
                    })

            elif msg_type == "launch_premiere":
                if user_id == room.host_id:
                    room.status = "screening"
                    for u in room.users.values():
                        u["location"] = "screening"

                    # Auto-master the scene into MP4 for the cast. Marked as rendering
                    # first, as the export route does, so no Refresh older takes starts
                    # now; then it waits for any refresh already running, so the render
                    # doesn't mix old and new audio.
                    room.export_status["16:9"] = "processing"
                    try:
                        await _wait_for_cleanup_refresh(room)
                        out_path = room.export_out_path("16:9")
                        takes = await rooms_api.mix_for_export(room)
                        await asyncio.to_thread(
                            audio_processor.export_dub_video,
                            room.pack, takes, out_path,
                            master_dialogue_presence_db=room.master_dialogue_presence_db,
                            mix_balance=room.master_mix_balance,
                        )
                        room.exported_video_path = out_path
                        room.export_status["16:9"] = "ready"
                        await room.broadcast("export_ready", room.export_ready_payload("16:9"))
                    except Exception as ex:
                        room.export_status["16:9"] = f"failed: {ex}"
                        print(f"[PremiereRenderError] {ex}")
                    finally:
                        # Cancelled (the host's socket closed) before it finished.
                        if room.export_status.get("16:9") == "processing":
                            room.export_status.pop("16:9", None)

                    await room.broadcast("warp_to_screening", {"triggered_by": user_id})

            elif msg_type == "screening_control":
                # Only host can control screening sync
                if user_id == room.host_id:
                    action = payload.get("action")  # 'play', 'pause', 'seek'
                    timestamp = payload.get("timestamp", 0.0)
                    await room.broadcast("screening_sync", {
                        "action": action,
                        "timestamp": timestamp,
                        "triggered_by": user_id
                    })

            elif msg_type == "set_dialogue_presence":
                if not _is_host(room, user_id):
                    await _refuse(websocket, "Only the host can change the mix.")
                    continue
                try:
                    presence_db = float(payload.get("presence_db", 0.0))
                except (TypeError, ValueError) as ex:
                    print(f"[WS] {room_id}/{user_id} ignored bad presence_db: {ex!r}")
                    continue
                room.master_dialogue_presence_db = max(-12.0, min(12.0, presence_db))
                room.invalidate_exports()
                await room.broadcast("dialogue_presence_sync", {
                    "presence_db": room.master_dialogue_presence_db,
                    "triggered_by": user_id
                })

            elif msg_type == "set_mix_balance":
                if not _is_host(room, user_id):
                    await _refuse(websocket, "Only the host can change the mix.")
                    continue
                try:
                    balance = float(payload.get("balance", 50.0))
                except (TypeError, ValueError) as ex:
                    print(f"[WS] {room_id}/{user_id} ignored bad balance: {ex!r}")
                    continue
                if balance != balance:  # NaN
                    continue
                room.master_mix_balance = max(0.0, min(100.0, balance))
                room.invalidate_exports()
                await room.broadcast("mix_balance_sync", {
                    "balance": room.master_mix_balance,
                    "triggered_by": user_id
                })

            elif msg_type == "ping":
                await websocket.send_text(json.dumps({"type": "pong"}))

    except (WebSocketDisconnect, ConnectionResetError, asyncio.CancelledError):
        room.sockets.discard(websocket)
        if user_id in room.users:
            room.users[user_id]["is_online"] = False
        await room.broadcast("user_disconnected", {"user_id": user_id})
    except Exception as ex:
        print(f"[WS] {room_id}/{user_id} handler error: {ex!r}")
        traceback.print_exc()
        room.sockets.discard(websocket)
        if user_id in room.users:
            room.users[user_id]["is_online"] = False
        try:
            await room.broadcast("user_disconnected", {"user_id": user_id})
        except Exception:
            pass
