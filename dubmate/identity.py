# -*- coding: utf-8 -*-
"""
dubmate/identity.py
Who someone is in a room: the person palette, names, and a colour nobody else in the
room has.

The palette and the table of older colours live in static/js/identity.js, the one
list the studio and the engine share. This module reads that file at import and
refuses to load unless it finds exactly 8 hues.
"""

import os
import re
from typing import Any, Dict, List, Optional, Tuple

from dubmate import common

NAME_MAX = 24

_COLORS_BLOCK_RE = re.compile(r"^export const IDENTITY_COLORS = \[\n(.*?)^\];$", re.S | re.M)
_COLOR_LINE_RE = re.compile(r"^  \{ name: '([A-Za-z]+)', hex: '(#[0-9a-f]{6})' \},$")
_LEGACY_BLOCK_RE = re.compile(r"^export const LEGACY_COLORS = \{\n(.*?)^\};$", re.S | re.M)
_LEGACY_LINE_RE = re.compile(r"^  '(#[0-9a-f]{6})': '([A-Za-z]+)',$")
_HEX_RE = re.compile(r"^#(?:[0-9a-f]{3}|[0-9a-f]{6})$")


def _block_lines(block_re: "re.Pattern[str]", line_re: "re.Pattern[str]", text: str, what: str) -> List[Tuple[str, str]]:
    match = block_re.search(text)
    if not match:
        raise ValueError(f"identity.js: {what} not found")
    entries = []
    for line in match.group(1).split("\n"):
        if not line:
            continue
        entry = line_re.match(line)
        if not entry:
            raise ValueError(f"identity.js: unexpected line in {what}: {line!r}")
        entries.append(entry.groups())
    return entries


def parse_identity_js(text: str) -> Tuple[List[Tuple[str, str]], Dict[str, str]]:
    """The palette as [(name, hex)] and the old colours as {old hex: palette hex}, read
    from identity.js's source. Raises ValueError unless there are exactly 8 distinct hues
    and every old colour maps onto one of them."""
    text = text.replace("\r\n", "\n")
    colors = _block_lines(_COLORS_BLOCK_RE, _COLOR_LINE_RE, text, "IDENTITY_COLORS")
    if len(colors) != 8 or len({n for n, _ in colors}) != 8 or len({h for _, h in colors}) != 8:
        raise ValueError(f"identity.js: expected 8 distinct hues, found {len(colors)}")
    by_name = dict(colors)
    legacy = {}
    for old_hex, name in _block_lines(_LEGACY_BLOCK_RE, _LEGACY_LINE_RE, text, "LEGACY_COLORS"):
        if name not in by_name:
            raise ValueError(f"identity.js: {old_hex} maps to unknown hue {name!r}")
        legacy[old_hex] = by_name[name]
    return colors, legacy


def _load() -> Tuple[List[Tuple[str, str]], Dict[str, str]]:
    path = os.path.join(common.find_static_dir(), "js", "identity.js")
    with open(path, "r", encoding="utf-8") as f:
        return parse_identity_js(f.read())


IDENTITY_COLORS, LEGACY_COLORS = _load()
PALETTE = [hex_ for _, hex_ in IDENTITY_COLORS]


def normalize_color(value: Any) -> str:
    """A palette hex for a palette hue or an older saved colour; "" for anything else
    (another colour, junk). The result is safe to put in a style attribute."""
    if not isinstance(value, str):
        return ""
    hex_ = value.strip().lower()
    if not _HEX_RE.match(hex_):
        return ""
    if hex_ in PALETTE:
        return hex_
    return LEGACY_COLORS.get(hex_, "")


def clean_name(value: Any) -> str:
    """Trimmed, inner whitespace collapsed, at most NAME_MAX characters (as identity.js cleanName)."""
    if not isinstance(value, str):
        return ""
    return " ".join(value.split())[:NAME_MAX].strip()


def pick_color(room: Optional[Any], wanted: Any, user_id: str) -> str:
    """The colour user_id gets in room (None: a room being created).

    Someone rejoining keeps their room colour unless a person online took it meanwhile.
    Otherwise wanted, if nobody else in the room holds it, else the first hue nobody
    else holds. When all 8 are held, people offline no longer count; when every hue is
    held by someone online, the one held by the fewest, earliest in the palette.
    """
    users = getattr(room, "users", None) or {}
    others = [u for uid, u in users.items() if uid != user_id and isinstance(u, dict)]

    def holders(hex_: str, online_only: bool) -> int:
        return sum(1 for u in others
                   if normalize_color(u.get("color")) == hex_ and (u.get("is_online") or not online_only))

    me = users.get(user_id)
    if isinstance(me, dict):
        mine = normalize_color(me.get("color"))
        if mine and holders(mine, online_only=True) == 0:
            return mine

    wanted_hex = normalize_color(wanted)
    for online_only in (False, True):
        if wanted_hex and holders(wanted_hex, online_only) == 0:
            return wanted_hex
        for hex_ in PALETTE:
            if holders(hex_, online_only) == 0:
                return hex_
    return min(PALETTE, key=lambda hex_: holders(hex_, online_only=True))
