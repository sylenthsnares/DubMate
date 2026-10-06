# -*- coding: utf-8 -*-
"""
vocal_chain.py
The voice chain: one sound engine for the booth preview and the export.

A chain is a dict ({"v", "preset", "nodes"}) of fixed-order nodes, each with "on", "mix"
and its own parameters (documentation/design/effects-rack.md, "The sound engine").
render() runs it with pedalboard (imported lazily, so the engine starts and records
without it) plus DubMate's own room impulse for reverb, convolved in numpy.

Pure functions on dicts and mono float32 numpy arrays. No files, no imports from
audio_processor (which imports the reverb helpers from here).
"""

import copy
import threading
from typing import Any, Dict, Optional, Tuple

import numpy as np

SR = 44100
CHAIN_VERSION = 1

NODE_ORDER = ("lowcut", "gate", "eq", "deess", "comp", "pitch", "reverb")

# Allowed range of every stored parameter. "mix" (0..1) applies to every node.
RANGES: Dict[str, Dict[str, Tuple[float, float]]] = {
    "lowcut": {"hz": (40.0, 400.0)},
    "gate": {"threshold_db": (-80.0, -20.0)},
    "eq": {"low_db": (-12.0, 12.0), "mid_db": (-12.0, 12.0), "mid_hz": (300.0, 5000.0), "high_db": (-12.0, 12.0)},
    "deess": {"threshold_db": (-50.0, -10.0), "hz": (3000.0, 10000.0)},
    "comp": {"threshold_db": (-40.0, 0.0), "ratio": (1.0, 10.0), "makeup_db": (0.0, 12.0)},
    "pitch": {"semitones": (-12.0, 12.0)},
    "reverb": {"decay_s": (0.2, 4.0), "predelay_ms": (0.0, 60.0)},
}
MIX_RANGE = (0.0, 1.0)
# Parameters stored as whole numbers (the dial steps by one).
_INTEGER_PARAMS = {("pitch", "semitones")}


def _chain(preset: Optional[str], **overrides: Dict[str, Any]) -> Dict[str, Any]:
    """A chain from Clean's nodes with some params replaced (used to spell out the presets)."""
    nodes = copy.deepcopy(_CLEAN_NODES)
    for name, params in overrides.items():
        nodes[name].update(params)
    return {"v": CHAIN_VERSION, "preset": preset, "nodes": nodes}


_CLEAN_NODES: Dict[str, Dict[str, Any]] = {
    "lowcut": {"on": True, "mix": 1.0, "hz": 80.0},
    "gate": {"on": False, "mix": 1.0, "threshold_db": -50.0},
    "eq": {"on": False, "mix": 1.0, "low_db": 0.0, "mid_db": 0.0, "mid_hz": 1500.0, "high_db": 0.0},
    "deess": {"on": False, "mix": 1.0, "threshold_db": -30.0, "hz": 6000.0},
    "comp": {"on": False, "mix": 1.0, "threshold_db": -18.0, "ratio": 3.0, "makeup_db": 0.0},
    "pitch": {"on": False, "mix": 1.0, "semitones": 0},
    "reverb": {"on": False, "mix": 0.3, "decay_s": 1.5, "predelay_ms": 20.0},
}

# Today's export sound: low cut at 80 Hz and nothing else.
CLEAN: Dict[str, Any] = _chain("clean")

# Values are tuned by ear in hands-on.
PRESETS: Dict[str, Dict[str, Any]] = {
    "clean": {"name": "Clean", "chain": CLEAN},
    "warm": {"name": "Warm", "chain": _chain(
        "warm",
        lowcut={"hz": 90.0},
        eq={"on": True, "low_db": 2.0, "mid_db": -1.0, "mid_hz": 400.0, "high_db": -1.5},
        deess={"on": True, "threshold_db": -28.0, "hz": 6000.0},
        comp={"on": True, "threshold_db": -20.0, "ratio": 2.5, "makeup_db": 3.0},
        reverb={"on": True, "mix": 0.12, "decay_s": 1.0, "predelay_ms": 15.0},
    )},
    "radio": {"name": "Radio", "chain": _chain(
        "radio",
        lowcut={"hz": 300.0},
        eq={"on": True, "low_db": -6.0, "mid_db": 5.0, "mid_hz": 1800.0, "high_db": -10.0},
        comp={"on": True, "threshold_db": -24.0, "ratio": 4.0, "makeup_db": 6.0},
    )},
    "monster": {"name": "Monster", "chain": _chain(
        "monster",
        lowcut={"hz": 60.0},
        pitch={"on": True, "semitones": -5},
        eq={"on": True, "low_db": 3.0, "high_db": -2.0},
        comp={"on": True, "threshold_db": -20.0, "ratio": 3.0, "makeup_db": 3.0},
        reverb={"on": True, "mix": 0.25, "decay_s": 1.8, "predelay_ms": 25.0},
    )},
}

# Hidden constants of the node table (not stored in a chain).
LOWCUT_STAGE_RATIO = 1.554          # two first-order high-passes at hz / 1.554: -3.0 dB at hz
GATE_RATIO, GATE_ATTACK_MS, GATE_RELEASE_MS = 10.0, 1.0, 120.0
EQ_LOW_SHELF_HZ, EQ_HIGH_SHELF_HZ, EQ_MID_Q = 150.0, 6000.0, 1.0
DEESS_RATIO, DEESS_ATTACK_MS, DEESS_RELEASE_MS = 6.0, 0.5, 40.0
COMP_ATTACK_MS, COMP_RELEASE_MS = 8.0, 120.0
REVERB_WET_SCALE = 0.7              # node wet = x + 0.7 * conv(x), so "mix" equals the old reverb_wet
REVERB_TAIL_PAD_S = 0.1
PREFIX_MARGIN_S = 0.25


# ---------------------------------------------------------------------------
# Schema
# ---------------------------------------------------------------------------

def _clean_number(value: Any, default: float, lo: float, hi: float) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return default
    value = float(value)
    if not np.isfinite(value):
        return default
    return min(hi, max(lo, value))


def normalize_chain(raw: Any) -> Dict[str, Any]:
    """
    A complete, valid chain from any dict: missing nodes and params come from Clean,
    every value is clamped to its range, floats are rounded to 3 decimals and unknown
    keys are dropped. "preset" survives only while the nodes are exactly that preset.
    """
    if not isinstance(raw, dict):
        raise ValueError("A chain must be an object.")
    raw_nodes = raw.get("nodes")
    if not isinstance(raw_nodes, dict):
        raw_nodes = {}

    nodes: Dict[str, Dict[str, Any]] = {}
    for name in NODE_ORDER:
        clean = _CLEAN_NODES[name]
        given = raw_nodes.get(name)
        if not isinstance(given, dict):
            given = {}
        on = given.get("on", clean["on"])
        node: Dict[str, Any] = {
            "on": on if isinstance(on, bool) else clean["on"],
            "mix": round(_clean_number(given.get("mix"), clean["mix"], *MIX_RANGE), 3),
        }
        for param, (lo, hi) in RANGES[name].items():
            value = _clean_number(given.get(param), float(clean[param]), lo, hi)
            node[param] = int(round(value)) if (name, param) in _INTEGER_PARAMS else round(value, 3)
        nodes[name] = node

    preset = raw.get("preset")
    if not (isinstance(preset, str) and preset in PRESETS and PRESETS[preset]["chain"]["nodes"] == nodes):
        preset = None
    return {"v": CHAIN_VERSION, "preset": preset, "nodes": nodes}


def resolve_chain(voice: Optional[Dict[str, Any]], character: Optional[str], take: Optional[Dict[str, Any]]) -> Dict[str, Any]:
    """
    The most specific chain that exists, each level replacing the whole chain:
    the take's own chain -> the character's (voice["characters"]) -> the room's
    (voice["session"]) -> Clean. Returns a fresh normalized chain.
    """
    voice = voice if isinstance(voice, dict) else {}
    characters = voice.get("characters") if isinstance(voice.get("characters"), dict) else {}
    for candidate in (
        (take or {}).get("chain") if isinstance(take, dict) else None,
        characters.get(character) if character is not None else None,
        voice.get("session"),
    ):
        if isinstance(candidate, dict):
            return normalize_chain(candidate)
    return normalize_chain(CLEAN)


def chain_with_legacy(chain: Dict[str, Any], pitch: Optional[float] = None, reverb_wet: Optional[float] = None) -> Dict[str, Any]:
    """
    The chain with the old Pitch / Reverb sliders' values applied: Pitch on at
    `pitch` semitones (off at 0), Reverb on at mix = `reverb_wet` (off at 0.02 or
    less, the old export's threshold). Switching a node off leaves its other values.
    None leaves that node as it is.
    """
    out = normalize_chain(chain)
    nodes = out["nodes"]
    if pitch is not None:
        nodes["pitch"]["on"] = abs(float(pitch)) > 0.01
        if nodes["pitch"]["on"]:
            nodes["pitch"]["semitones"] = pitch
    if reverb_wet is not None:
        nodes["reverb"]["on"] = float(reverb_wet) > 0.02
        if nodes["reverb"]["on"]:
            nodes["reverb"]["mix"] = reverb_wet
    return normalize_chain(out)


def chain_from_legacy(pitch: float = 0.0, reverb_wet: float = 0.0) -> Dict[str, Any]:
    """Clean plus the old per-take pitch and reverb (Reverb keeps its 1.5 s, 20 ms room)."""
    return chain_with_legacy(CLEAN, pitch=pitch, reverb_wet=reverb_wet)


# ---------------------------------------------------------------------------
# Reverb (DubMate's own room impulse, convolved in numpy)
# ---------------------------------------------------------------------------

_REVERB_CACHE: Dict[Tuple[float, int, float], np.ndarray] = {}


def get_reverb_impulse(decay_sec: float = 1.5, sr: int = SR, predelay_ms: float = 20.0) -> np.ndarray:
    """Generates and caches an acoustic room impulse response with exponential decay and diffusion."""
    decay_sec = round(float(decay_sec), 3)
    predelay_ms = round(float(predelay_ms), 3)
    cache_key = (decay_sec, sr, predelay_ms)
    if cache_key in _REVERB_CACHE:
        return _REVERB_CACHE[cache_key]

    length = int(sr * min(4.0, max(0.2, decay_sec)))
    pre_delay = min(length - 1, int(sr * (predelay_ms / 1000.0)))
    impulse = np.zeros(length, dtype=np.float32)
    t = np.arange(length - pre_delay, dtype=np.float32) / float(sr)
    envelope = np.exp(-3.2 * t / max(0.1, decay_sec))

    rng = np.random.default_rng(42)  # Deterministic room reflection pattern (local RNG, no global mutation)
    impulse[pre_delay:] = (rng.random(len(t)).astype(np.float32) * 2.0 - 1.0) * envelope
    norm = np.sqrt(np.sum(impulse ** 2))
    if norm > 1e-6:
        impulse /= norm

    _REVERB_CACHE[cache_key] = impulse
    return impulse


def _fft_convolve(signal: np.ndarray, kernel: np.ndarray) -> np.ndarray:
    """
    Full linear convolution (length len(signal) + len(kernel) - 1) through numpy's real FFT.
    Replaces scipy.signal.fftconvolve, the only thing scipy was installed for. The FFT runs
    in float64 and the result is float32, like fftconvolve gave for float32 input.
    """
    n = len(signal) + len(kernel) - 1
    nfft = 1 << (n - 1).bit_length()
    spectrum = np.fft.rfft(np.asarray(signal, dtype=np.float64), nfft) * np.fft.rfft(np.asarray(kernel, dtype=np.float64), nfft)
    return np.fft.irfft(spectrum, nfft)[:n].astype(np.float32)


# ---------------------------------------------------------------------------
# Rendering
# ---------------------------------------------------------------------------

def _run(plugins, audio: np.ndarray, sr: int) -> np.ndarray:
    pb = _pedalboard_module()
    return np.asarray(pb.Pedalboard(plugins)(audio, sr), dtype=np.float32).reshape(-1)


def _node_wet(name: str, node: Dict[str, Any], x: np.ndarray, sr: int) -> np.ndarray:
    pb = _pedalboard_module()
    if name == "lowcut":
        cutoff = node["hz"] / LOWCUT_STAGE_RATIO
        return _run([pb.HighpassFilter(cutoff), pb.HighpassFilter(cutoff)], x, sr)
    if name == "gate":
        return _run([pb.NoiseGate(threshold_db=node["threshold_db"], ratio=GATE_RATIO,
                                  attack_ms=GATE_ATTACK_MS, release_ms=GATE_RELEASE_MS)], x, sr)
    if name == "eq":
        return _run([
            pb.LowShelfFilter(cutoff_frequency_hz=EQ_LOW_SHELF_HZ, gain_db=node["low_db"]),
            pb.PeakFilter(cutoff_frequency_hz=node["mid_hz"], gain_db=node["mid_db"], q=EQ_MID_Q),
            pb.HighShelfFilter(cutoff_frequency_hz=EQ_HIGH_SHELF_HZ, gain_db=node["high_db"]),
        ], x, sr)
    if name == "deess":
        sib = _run([pb.HighpassFilter(node["hz"]), pb.HighpassFilter(node["hz"])], x, sr)
        squashed = _run([pb.Compressor(threshold_db=node["threshold_db"], ratio=DEESS_RATIO,
                                       attack_ms=DEESS_ATTACK_MS, release_ms=DEESS_RELEASE_MS)], sib, sr)
        return x - sib + squashed
    if name == "comp":
        return _run([pb.Compressor(threshold_db=node["threshold_db"], ratio=node["ratio"],
                                   attack_ms=COMP_ATTACK_MS, release_ms=COMP_RELEASE_MS),
                     pb.Gain(gain_db=node["makeup_db"])], x, sr)
    if name == "pitch":
        return _run([pb.PitchShift(semitones=float(node["semitones"]))], x, sr)
    if name == "reverb":
        impulse = get_reverb_impulse(node["decay_s"], sr, node["predelay_ms"])
        return x + np.float32(REVERB_WET_SCALE) * _fft_convolve(x, impulse)[:len(x)]
    raise ValueError(f"Unknown effect {name!r}")


def render(audio: np.ndarray, chain: Dict[str, Any], sr: int = SR, until_s: Optional[float] = None) -> np.ndarray:
    """
    Runs a mono take through its chain. When Reverb is on the input is padded with
    0.1 s plus the impulse length of silence so the tail is kept; otherwise the output
    has the input's length. With until_s only the first until_s + 0.25 s are rendered
    and [0, until_s] is returned (equal to the full render over that range).
    Raises RuntimeError when pedalboard isn't available.
    """
    chain = normalize_chain(chain)
    if not available():
        raise RuntimeError("Voice effects aren't installed.")
    x = np.asarray(audio, dtype=np.float32).reshape(-1)
    keep = None
    if until_s is not None:
        keep = max(0, int(round(float(until_s) * sr)))
        x = x[:keep + int(round(PREFIX_MARGIN_S * sr))]

    reverb = chain["nodes"]["reverb"]
    if reverb["on"]:
        pad = int(round(REVERB_TAIL_PAD_S * sr)) + len(get_reverb_impulse(reverb["decay_s"], sr, reverb["predelay_ms"]))
        x = np.concatenate([x, np.zeros(pad, dtype=np.float32)])
    x = np.ascontiguousarray(x, dtype=np.float32)

    if len(x):
        for name in NODE_ORDER:
            node = chain["nodes"][name]
            if not node["on"]:
                continue
            wet = _node_wet(name, node, x, sr)
            mix = node["mix"]
            x = wet if mix >= 1.0 else (x + np.float32(mix) * (wet - x)).astype(np.float32)

    return x if keep is None else x[:keep]


# ---------------------------------------------------------------------------
# pedalboard availability
# ---------------------------------------------------------------------------
# The engine never installs packages itself: the installer ships them in the bundled
# runtime, and the desktop updater installs a new requirements.txt before it restarts
# the engine (tauri/src-tauri/src/updater.rs). Source installs get them from update.bat
# / update.sh.

_pedalboard = None
_checked = False
_import_lock = threading.Lock()


def available() -> bool:
    """True when pedalboard imports. Cached for the life of the engine."""
    global _pedalboard, _checked
    with _import_lock:
        if not _checked:
            try:
                import pedalboard
                _pedalboard = pedalboard
            except ImportError:
                _pedalboard = None
            _checked = True
        return _pedalboard is not None


def _pedalboard_module():
    if not available():
        raise RuntimeError("Voice effects aren't installed.")
    return _pedalboard
