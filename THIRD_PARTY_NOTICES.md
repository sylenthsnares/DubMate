<!--
How this file was made (check it again before each release; tests/test_third_party_notices.py
fails when a shipped binary, requirement, pinned build, runtime, speaker model or font isn't named):

  Python packages in the desktop app, resolved the way tauri/scripts/stage-sidecars.* install them:
    py -3.12 -m venv notices-venv
    notices-venv/Scripts/python -m pip install --upgrade pip setuptools wheel
    notices-venv/Scripts/python -m pip install -r requirements.txt
    then, for each importlib.metadata.distributions(): Name, version, License-Expression
    (or License / the License :: classifiers), the source Project-URL and the licence files.

  Rust crates in the desktop app (normal dependencies reachable from dubmate-studio):
    cd tauri/src-tauri
    cargo metadata --format-version 1 --locked --filter-platform x86_64-pc-windows-msvc
    cargo metadata --format-version 1 --locked --filter-platform aarch64-apple-darwin
    cargo metadata --format-version 1 --locked --filter-platform x86_64-apple-darwin
    copyright lines come from each crate's LICENSE / COPYING / COPYRIGHT files, or its
    Cargo.toml authors when those have none.

  Resolved on 2026-10-09 with Python 3.12 on Windows.
-->

# Third-party notices

DubMate is free software under the [GNU General Public License v3](LICENSE). It's built on the work of the projects below. Thank you to everyone who made them.

Versions marked "at build time" aren't pinned: each release gets the newest version allowed when it's built. The versions shown are the ones current when this file was last checked.

1. [In the desktop app](#1-in-the-desktop-app)
2. [Downloaded when you install the Pack Builder](#2-downloaded-when-you-install-the-pack-builder)
3. [Models downloaded on first use](#3-models-downloaded-on-first-use)
4. [Code adapted from other projects](#4-code-adapted-from-other-projects)
5. [Licence texts](#5-licence-texts)

## 1. In the desktop app

### DubMate

DubMate itself, including the desktop app, the engine, the studio and the Pack Builder. Licence: GPL-3.0 ([LICENSE](LICENSE)). Source: <https://github.com/sylenthsnares/DubMate>, tagged for each release.

### Python

| Component | Version | Licence | Source |
|---|---|---|---|
| CPython for Windows, the embeddable package from python.org | CPython 3.12.4 | PSF-2.0 | <https://www.python.org/downloads/release/python-3124/> |
| CPython for macOS, from python-build-standalone 20240713 | CPython 3.12.4 | PSF-2.0 (python-build-standalone's build scripts are MPL-2.0) | <https://github.com/indygreg/python-build-standalone/releases/tag/20240713> |

- **Windows:** `LICENSE.txt` in the app's `python-runtime` folder has Python's licence, the licences of the libraries Python is built with (bzip2, libffi, OpenSSL, SQLite, XZ, zlib and others), and the terms for the Microsoft Visual C++ runtime that comes with it.
- **macOS:** `python-runtime/lib/python3.12/LICENSE.txt` has Python's licence. python-build-standalone builds Python with OpenSSL 3.0 (Apache-2.0), SQLite (public domain), bzip2, XZ, expat, mpdecimal, libedit, ncurses, libuuid and Tcl/Tk, each under its own permissive licence. Their licences are listed in [python-build-standalone's documentation](https://gregoryszorc.com/docs/python-build-standalone/main/running.html#licensing).

### Python packages

Installed from `requirements.txt` with pip, plus pip, setuptools and wheel. Versions are the ones pip picked at build time, except pedalboard, which is pinned. Each package's own licence files ship with it, in the `.dist-info` folders inside `python-runtime`.

| Package | Version | Licence | Copyright | Source |
|---|---|---|---|---|
| annotated-doc | 0.0.5 | MIT | (c) 2025 Sebastián Ramírez | <https://github.com/fastapi/annotated-doc> |
| annotated-types | 0.8.0 | MIT | (c) 2022 the contributors | <https://github.com/annotated-types/annotated-types> |
| anyio | 4.15.1 | MIT | (c) 2018 Alex Grönholm | <https://github.com/agronholm/anyio> |
| certifi | 2026.7.22 | MPL-2.0 | the certifi authors; Mozilla's CA bundle | <https://github.com/certifi/python-certifi> |
| click | 8.5.0 | BSD-3-Clause | 2014 Pallets | <https://github.com/pallets/click> |
| fastapi | 0.143.0 | MIT | (c) 2018 Sebastián Ramírez | <https://github.com/fastapi/fastapi> |
| h11 | 0.16.0 | MIT | (c) 2016 Nathaniel J. Smith and other contributors | <https://github.com/python-hyper/h11> |
| httpcore | 1.0.9 | BSD-3-Clause | (c) 2020, Encode OSS Ltd | <https://github.com/encode/httpcore> |
| httptools | 0.8.0 | MIT (includes llhttp and http-parser, MIT) | (c) 2015 MagicStack Inc. | <https://github.com/MagicStack/httptools> |
| httpx | 0.28.1 | BSD-3-Clause | (c) 2019, Encode OSS Ltd | <https://github.com/encode/httpx> |
| idna | 3.20 | BSD-3-Clause | (c) 2013-2026, Kim Davies and contributors | <https://github.com/kjd/idna> |
| numpy | 2.5.3 | BSD-3-Clause AND 0BSD AND MIT AND Zlib AND CC0-1.0 | (c) 2005-2025, NumPy Developers. The Windows build includes OpenBLAS and LAPACK (BSD-3-Clause) and the GCC runtime library (GPL-3.0-or-later WITH GCC-exception-3.1); numpy's `LICENSE.txt` lists them | <https://github.com/numpy/numpy> |
| opentelemetry-api | 1.45.1 | Apache-2.0 | The OpenTelemetry Authors | <https://github.com/open-telemetry/opentelemetry-python> |
| packaging | 26.3 | Apache-2.0 OR BSD-2-Clause, used under Apache-2.0 | Donald Stufft and individual contributors | <https://github.com/pypa/packaging> |
| pedalboard | 0.9.24 | GPL-3.0 (see [pedalboard](#pedalboard)) | 2021-2025 Spotify AB | <https://github.com/spotify/pedalboard> |
| pip | 26.2.1 | MIT (its bundled libraries are listed in its licence files) | (c) 2008-present The pip developers | <https://github.com/pypa/pip> |
| pydantic | 2.14.0 | MIT | (c) 2017 to present Pydantic Services Inc. and individual contributors | <https://github.com/pydantic/pydantic> |
| pydantic_core | 2.50.0 | MIT | (c) 2022 Samuel Colvin | <https://github.com/pydantic/pydantic> |
| python-dotenv | 1.2.4 | BSD-3-Clause | (c) 2014, Saurabh Kumar; 2013, Ted Tieken; 2013, Jacob Kaplan-Moss | <https://github.com/theskumar/python-dotenv> |
| python-multipart | 0.0.32 | Apache-2.0 | the python-multipart authors | <https://github.com/Kludex/python-multipart> |
| PyYAML | 6.0.3 | MIT | (c) 2017-2021 Ingy döt Net; (c) 2006-2016 Kirill Simonov | <https://github.com/yaml/pyyaml> |
| setuptools | 84.0.0 | MIT (its bundled libraries are listed in its licence files) | the setuptools developers | <https://github.com/pypa/setuptools> |
| starlette | 1.7.0 | BSD-3-Clause | (c) 2018, Encode OSS Ltd | <https://github.com/Kludex/starlette> |
| typing-inspection | 0.4.4 | MIT | (c) Pydantic Services Inc. 2025 to present | <https://github.com/pydantic/typing-inspection> |
| typing_extensions | 4.16.0 | PSF-2.0 | Python Software Foundation | <https://github.com/python/typing_extensions> |
| uvicorn | 0.54.0 | BSD-3-Clause | (c) 2017-present, Encode OSS Ltd | <https://github.com/Kludex/uvicorn> |
| uvloop (macOS only) | at build time | MIT OR Apache-2.0, used under Apache-2.0 | the uvloop authors and contributors | <https://github.com/MagicStack/uvloop> |
| watchfiles | 1.3.0 | MIT | (c) 2017 to present Samuel Colvin | <https://github.com/samuelcolvin/watchfiles> |
| websockets | 17.2 | BSD-3-Clause | (c) Aymeric Augustin and contributors | <https://github.com/python-websockets/websockets> |
| wheel | 0.48.0 | MIT | (c) 2012 Daniel Holth and contributors | <https://github.com/pypa/wheel> |

### pedalboard

pedalboard 0.9.24 (voice effects) is GPL-3.0, Copyright 2021-2025 Spotify AB. It is built with:

- JUCE (GPL-3.0), Copyright Raw Material Software Limited, including Steinberg's VST3 SDK (GPL-3.0);
- the Rubber Band Library (GPL-2.0-or-later) and FFTW (GPL-2.0-or-later);
- LAME's libmp3lame (LGPL-2.0, used under GPL-3.0);
- libgsm (ISC) and dr_wav (public domain).

Source: <https://github.com/spotify/pedalboard/tree/v0.9.24>. Its `LICENSE` and `NOTICE` ship in `pedalboard-0.9.24.dist-info`.

### FFmpeg

FFmpeg makes the videos and reads your recordings. Shipped as `ffmpeg`.

- **Windows:** BtbN's FFmpeg build `ffmpeg-n8.1.2-34-g9b6c8969e0-win64-gpl-8.1`, from the release `autobuild-2026-07-31-14-10` (pinned by SHA-256). It is configured with `--enable-gpl --enable-version3`, so this build of FFmpeg, with the libraries built into it, is under the GPL-3.0.
- **macOS:** the FFmpeg build from Homebrew at build time. Homebrew builds it under the GPL-3.0-or-later.

**Source code.** The GPL gives you the right to the source code of these builds:

- FFmpeg's source at the exact commit of the Windows build, 9b6c8969e0: <https://git.ffmpeg.org/gitweb/ffmpeg.git/commit/9b6c8969e0> (mirror: <https://github.com/FFmpeg/FFmpeg/commit/9b6c8969e0>).
- The scripts that built it, which name the exact version of every library inside it: <https://github.com/BtbN/FFmpeg-Builds/tree/autobuild-2026-07-31-14-10>.
- The macOS build: Homebrew's formula and the source it builds from, <https://formulae.brew.sh/formula/ffmpeg>.

If one of these links stops working, ask in a [GitHub issue](https://github.com/sylenthsnares/DubMate/issues) and we'll send you the source for the build we shipped.

### DeepFilterNet

DeepFilterNet 0.5.6 cleans background noise from takes. Shipped as `deep-filter`, the project's standalone binary (pinned by SHA-256). Its speech model is built into the binary. Licence: MIT OR Apache-2.0, Copyright (c) 2021 Hendrik Schröter. Source: <https://github.com/Rikorose/DeepFilterNet/tree/v0.5.6>.

### cloudflared

cloudflared opens the connection friends join through. Shipped as `cloudflared`, the latest release at build time. Licence: Apache-2.0, by Cloudflare. Source: <https://github.com/cloudflare/cloudflared>.

### The desktop app's Rust crates

The desktop app is written in Rust with Tauri. It uses these crates directly: tauri, tauri-plugin-shell, tokio, reqwest, futures-util, serde, serde_json, regex and zip, plus webview2-com and windows on Windows (all MIT OR Apache-2.0). tauri-build is used to build it.

With everything they use in turn, the app is built from 349 crates:

| Licence | Crates |
|---|---|
| MIT or Apache-2.0, among other choices; used under MIT or Apache-2.0 | 246 |
| MIT | 65 |
| Unicode-3.0 | 18 |
| MPL-2.0 | 5 |
| BSD-3-Clause | 3 |
| Apache-2.0 | 3 |
| Zlib | 2 |
| ISC | 2 |
| BSD-3-Clause AND MIT | 1 |
| Apache-2.0 AND MIT | 1 |
| (Apache-2.0 OR MIT) AND BSD-3-Clause | 1 |
| Apache-2.0 AND ISC | 1 |
| (MIT OR Apache-2.0) AND Unicode-3.0 | 1 |

The crates that aren't under MIT or Apache-2.0:

- alloc-no-stdlib 2.0.4 (BSD-3-Clause)
- alloc-stdlib 0.2.4 (BSD-3-Clause)
- brotli 8.0.4 (BSD-3-Clause AND MIT)
- cssparser-macros 0.6.1 (MPL-2.0)
- cssparser 0.36.0 (MPL-2.0)
- dpi 0.1.2 (Apache-2.0 AND MIT)
- dtoa-short 0.3.5 (MPL-2.0)
- encoding_rs 0.8.35 ((Apache-2.0 OR MIT) AND BSD-3-Clause)
- foldhash 0.2.0 (Zlib)
- icu_collections 2.3.0 (Unicode-3.0)
- icu_locale_core 2.3.0 (Unicode-3.0)
- icu_normalizer_data 2.3.0 (Unicode-3.0)
- icu_normalizer 2.3.0 (Unicode-3.0)
- icu_properties_data 2.3.0 (Unicode-3.0)
- icu_properties 2.3.0 (Unicode-3.0)
- icu_provider 2.3.1 (Unicode-3.0)
- litemap 0.8.3 (Unicode-3.0)
- option-ext 0.2.0 (MPL-2.0)
- potential_utf 0.1.6 (Unicode-3.0)
- ring 0.17.14 (Apache-2.0 AND ISC)
- rustls-webpki 0.103.15 (ISC)
- selectors 0.36.1 (MPL-2.0)
- subtle 2.6.1 (BSD-3-Clause)
- tinystr 0.8.4 (Unicode-3.0)
- unicode-ident 1.0.24 ((MIT OR Apache-2.0) AND Unicode-3.0)
- untrusted 0.9.0 (ISC)
- writeable 0.6.4 (Unicode-3.0)
- yoke-derive 0.8.2 (Unicode-3.0)
- yoke 0.8.3 (Unicode-3.0)
- zerofrom-derive 0.1.7 (Unicode-3.0)
- zerofrom 0.1.8 (Unicode-3.0)
- zerotrie 0.2.5 (Unicode-3.0)
- zerovec-derive 0.11.6 (Unicode-3.0)
- zerovec 0.11.8 (Unicode-3.0)
- zlib-rs 0.6.7 (Zlib)

The MPL-2.0 crates are used unchanged. Their source is on crates.io, for example <https://crates.io/crates/cssparser/0.36.0>.

<details>
<summary>All 349 crates</summary>

- adler2 2.0.1: 0BSD OR MIT OR Apache-2.0
- aes 0.8.4: MIT OR Apache-2.0
- aho-corasick 1.1.5: Unlicense OR MIT
- alloc-no-stdlib 2.0.4: BSD-3-Clause
- alloc-stdlib 0.2.4: BSD-3-Clause
- anyhow 1.0.104: MIT OR Apache-2.0
- atomic-waker 1.1.2: Apache-2.0 OR MIT
- base64 0.21.7: MIT OR Apache-2.0 (macOS only)
- base64 0.22.1: MIT OR Apache-2.0
- bit-set 0.8.0: Apache-2.0 OR MIT
- bit-vec 0.8.0: Apache-2.0 OR MIT
- bitflags 1.3.2: MIT OR Apache-2.0
- bitflags 2.13.1: MIT OR Apache-2.0
- block-buffer 0.10.4: MIT OR Apache-2.0
- block2 0.6.2: MIT (macOS only)
- brotli-decompressor 5.0.3: BSD-3-Clause OR MIT
- brotli 8.0.4: BSD-3-Clause AND MIT
- bs58 0.5.1: MIT OR Apache-2.0
- bumpalo 3.20.3: MIT OR Apache-2.0
- byteorder 1.5.0: Unlicense OR MIT
- bytes 1.12.1: MIT
- bzip2-sys 0.1.13+1.0.8: MIT OR Apache-2.0
- bzip2 0.5.2: MIT OR Apache-2.0
- camino 1.2.5: MIT OR Apache-2.0
- cargo-platform 0.1.9: MIT OR Apache-2.0
- cargo_metadata 0.19.2: MIT
- cfb 0.7.3: MIT
- cfg-if 1.0.4: MIT OR Apache-2.0
- chrono 0.4.45: MIT OR Apache-2.0
- cipher 0.4.4: MIT OR Apache-2.0
- constant_time_eq 0.3.1: CC0-1.0 OR MIT-0 OR Apache-2.0
- cookie 0.18.2: MIT OR Apache-2.0
- core-foundation-sys 0.8.7: MIT OR Apache-2.0 (macOS only)
- core-foundation 0.10.1: MIT OR Apache-2.0 (macOS only)
- core-foundation 0.9.4: MIT OR Apache-2.0 (macOS only)
- core-graphics-types 0.2.0: MIT OR Apache-2.0 (macOS only)
- core-graphics 0.25.0: MIT OR Apache-2.0 (macOS only)
- cpufeatures 0.2.17: MIT OR Apache-2.0
- crc-catalog 2.5.0: MIT OR Apache-2.0
- crc32fast 1.5.1: MIT OR Apache-2.0
- crc 3.4.0: MIT OR Apache-2.0
- crossbeam-channel 0.5.16: MIT OR Apache-2.0
- crossbeam-utils 0.8.22: MIT OR Apache-2.0
- crypto-common 0.1.7: MIT OR Apache-2.0
- cssparser-macros 0.6.1: MPL-2.0
- cssparser 0.36.0: MPL-2.0
- ctor-proc-macro 0.0.7: Apache-2.0 OR MIT
- ctor 0.8.0: Apache-2.0 OR MIT
- darling_core 0.23.0: MIT
- darling_macro 0.23.0: MIT
- darling 0.23.0: MIT
- deflate64 0.1.12: MIT
- defmt-macros 1.1.1: MIT OR Apache-2.0
- defmt-parser 1.0.0: MIT OR Apache-2.0
- defmt 1.1.1: MIT OR Apache-2.0
- deranged 0.5.8: MIT OR Apache-2.0
- derive_more-impl 2.1.1: MIT
- derive_more 2.1.1: MIT
- digest 0.10.7: MIT OR Apache-2.0
- dirs-sys 0.5.0: MIT OR Apache-2.0
- dirs 6.0.0: MIT OR Apache-2.0
- dispatch2 0.3.1: Zlib OR Apache-2.0 OR MIT (macOS only)
- displaydoc 0.2.7: MIT OR Apache-2.0
- dom_query 0.27.0: MIT
- dpi 0.1.2: Apache-2.0 AND MIT
- dtoa-short 0.3.5: MPL-2.0
- dtoa 1.0.11: MIT OR Apache-2.0
- dtor-proc-macro 0.0.6: Apache-2.0 OR MIT
- dtor 0.3.0: Apache-2.0 OR MIT
- dunce 1.0.5: CC0-1.0 OR MIT-0 OR Apache-2.0
- dyn-clone 1.0.20: MIT OR Apache-2.0
- embed_plist 1.2.2: MIT OR Apache-2.0 (macOS only)
- encoding_rs 0.8.35: (Apache-2.0 OR MIT) AND BSD-3-Clause
- equivalent 1.0.2: Apache-2.0 OR MIT
- erased-serde 0.4.10: MIT OR Apache-2.0
- errno 0.3.14: MIT OR Apache-2.0 (macOS only)
- fastrand 2.5.0: Apache-2.0 OR MIT
- fdeflate 0.3.7: MIT OR Apache-2.0
- flate2 1.1.10: MIT OR Apache-2.0
- fnv 1.0.7: Apache-2.0 OR MIT
- foldhash 0.2.0: Zlib
- foreign-types-macros 0.2.4: MIT OR Apache-2.0 (macOS only)
- foreign-types-shared 0.3.1: MIT OR Apache-2.0 (macOS only)
- foreign-types 0.5.0: MIT OR Apache-2.0 (macOS only)
- form_urlencoded 1.2.2: MIT OR Apache-2.0
- futures-channel 0.3.34: MIT OR Apache-2.0
- futures-core 0.3.34: MIT OR Apache-2.0
- futures-io 0.3.34: MIT OR Apache-2.0
- futures-macro 0.3.34: MIT OR Apache-2.0
- futures-sink 0.3.34: MIT OR Apache-2.0
- futures-task 0.3.34: MIT OR Apache-2.0
- futures-util 0.3.34: MIT OR Apache-2.0
- generic-array 0.14.7: MIT
- getrandom 0.2.17: MIT OR Apache-2.0
- getrandom 0.3.4: MIT OR Apache-2.0
- getrandom 0.4.3: MIT OR Apache-2.0
- glob 0.3.4: MIT OR Apache-2.0
- h2 0.4.19: MIT
- hashbrown 0.12.3: MIT OR Apache-2.0
- hashbrown 0.17.1: MIT OR Apache-2.0
- heck 0.5.0: MIT OR Apache-2.0
- hex 0.4.3: MIT OR Apache-2.0
- hmac 0.12.1: MIT OR Apache-2.0
- html5ever 0.38.0: MIT OR Apache-2.0
- http-body-util 0.1.5: MIT
- http-body 1.1.0: MIT
- httparse 1.10.1: MIT OR Apache-2.0
- http 1.5.0: MIT OR Apache-2.0
- hyper-rustls 0.27.9: Apache-2.0 OR ISC OR MIT
- hyper-tls 0.6.0: MIT OR Apache-2.0
- hyper-util 0.1.20: MIT
- hyper 1.11.0: MIT
- iana-time-zone 0.1.65: MIT OR Apache-2.0 (macOS only)
- ico 0.5.0: MIT
- icu_collections 2.3.0: Unicode-3.0
- icu_locale_core 2.3.0: Unicode-3.0
- icu_normalizer_data 2.3.0: Unicode-3.0
- icu_normalizer 2.3.0: Unicode-3.0
- icu_properties_data 2.3.0: Unicode-3.0
- icu_properties 2.3.0: Unicode-3.0
- icu_provider 2.3.1: Unicode-3.0
- ident_case 1.0.1: MIT OR Apache-2.0
- idna_adapter 1.2.2: Apache-2.0 OR MIT
- idna 1.1.0: MIT OR Apache-2.0
- indexmap 1.9.3: Apache-2.0 OR MIT
- indexmap 2.14.0: Apache-2.0 OR MIT
- infer 0.19.0: MIT
- inout 0.1.4: MIT OR Apache-2.0
- ipnet 2.12.1: MIT OR Apache-2.0
- itoa 1.0.18: MIT OR Apache-2.0
- jiff-core 0.1.0: Unlicense OR MIT
- jiff-tzdb-platform 0.1.3: Unlicense OR MIT (Windows only)
- jiff-tzdb 0.1.8: Unlicense OR MIT (Windows only)
- jiff 0.2.35: Unlicense OR MIT
- json-patch 3.0.1: MIT OR Apache-2.0
- jsonptr 0.6.3: MIT OR Apache-2.0
- keyboard-types 0.7.0: MIT OR Apache-2.0
- libc 0.2.189: MIT OR Apache-2.0
- litemap 0.8.3: Unicode-3.0
- lock_api 0.4.14: MIT OR Apache-2.0
- log 0.4.34: MIT OR Apache-2.0
- lzma-rs 0.3.0: MIT
- lzma-sys 0.1.20: MIT OR Apache-2.0
- markup5ever 0.38.0: MIT OR Apache-2.0
- memchr 2.8.3: Unlicense OR MIT
- mime 0.3.17: MIT OR Apache-2.0
- miniz_oxide 0.8.9: MIT OR Zlib OR Apache-2.0
- miniz_oxide 0.9.1: MIT OR Zlib OR Apache-2.0
- mio 1.2.2: MIT
- muda 0.19.3: Apache-2.0 OR MIT
- native-tls 0.2.18: MIT OR Apache-2.0
- new_debug_unreachable 1.0.6: MIT
- num-conv 0.2.2: MIT OR Apache-2.0
- num-traits 0.2.19: MIT OR Apache-2.0
- objc2-app-kit 0.3.2: Zlib OR Apache-2.0 OR MIT (macOS only)
- objc2-core-foundation 0.3.2: Zlib OR Apache-2.0 OR MIT (macOS only)
- objc2-core-graphics 0.3.2: Zlib OR Apache-2.0 OR MIT (macOS only)
- objc2-encode 4.1.0: MIT (macOS only)
- objc2-exception-helper 0.1.1: Zlib OR Apache-2.0 OR MIT (macOS only)
- objc2-foundation 0.3.2: MIT (macOS only)
- objc2-io-surface 0.3.2: Zlib OR Apache-2.0 OR MIT (macOS only)
- objc2-web-kit 0.3.2: Zlib OR Apache-2.0 OR MIT (macOS only)
- objc2 0.6.4: MIT (macOS only)
- once_cell 1.21.4: MIT OR Apache-2.0
- open 5.4.2: MIT
- option-ext 0.2.0: MPL-2.0
- os_pipe 1.2.3: MIT
- parking_lot_core 0.9.12: MIT OR Apache-2.0
- parking_lot 0.12.5: MIT OR Apache-2.0
- pbkdf2 0.12.2: MIT OR Apache-2.0
- percent-encoding 2.3.2: MIT OR Apache-2.0
- phf_generator 0.13.1: MIT
- phf_macros 0.13.1: MIT
- phf_shared 0.13.1: MIT
- phf 0.13.1: MIT
- pin-project-lite 0.2.17: Apache-2.0 OR MIT
- plist 1.10.0: MIT
- png 0.17.16: MIT OR Apache-2.0
- png 0.18.1: MIT OR Apache-2.0 (macOS only)
- potential_utf 0.1.6: Unicode-3.0
- powerfmt 0.2.0: MIT OR Apache-2.0
- precomputed-hash 0.1.1: MIT
- proc-macro2 1.0.107: MIT OR Apache-2.0
- quick-xml 0.41.0: MIT
- quote 1.0.47: MIT OR Apache-2.0
- raw-window-handle 0.6.2: MIT OR Apache-2.0 OR Zlib
- ref-cast-impl 1.0.27: MIT OR Apache-2.0
- ref-cast 1.0.27: MIT OR Apache-2.0
- regex-automata 0.4.18: MIT OR Apache-2.0
- regex-syntax 0.8.11: MIT OR Apache-2.0
- regex 1.13.1: MIT OR Apache-2.0
- reqwest 0.12.28: MIT OR Apache-2.0
- ring 0.17.14: Apache-2.0 AND ISC
- rustc-hash 2.1.3: Apache-2.0 OR MIT
- rustix 1.1.4: Apache-2.0 WITH LLVM-exception OR Apache-2.0 OR MIT (macOS only)
- rustls-pki-types 1.15.1: MIT OR Apache-2.0
- rustls-webpki 0.103.15: ISC
- rustls 0.23.43: Apache-2.0 OR ISC OR MIT
- ryu 1.0.23: Apache-2.0 OR BSL-1.0
- same-file 1.0.6: Unlicense OR MIT
- schannel 0.1.29: MIT (Windows only)
- schemars_derive 0.8.22: MIT
- schemars 0.8.22: MIT
- schemars 0.9.0: MIT
- schemars 1.2.2: MIT
- scopeguard 1.2.0: MIT OR Apache-2.0
- security-framework-sys 2.17.0: MIT OR Apache-2.0 (macOS only)
- security-framework 3.7.0: MIT OR Apache-2.0 (macOS only)
- selectors 0.36.1: MPL-2.0
- semver 1.0.28: MIT OR Apache-2.0
- serde-untagged 0.1.9: MIT OR Apache-2.0
- serde_core 1.0.229: MIT OR Apache-2.0
- serde_derive_internals 0.29.1: MIT OR Apache-2.0
- serde_derive 1.0.229: MIT OR Apache-2.0
- serde_json 1.0.151: MIT OR Apache-2.0
- serde_repr 0.1.21: MIT OR Apache-2.0
- serde_spanned 1.1.1: MIT OR Apache-2.0
- serde_urlencoded 0.7.1: MIT OR Apache-2.0
- serde_with_macros 3.22.0: MIT OR Apache-2.0
- serde_with 3.22.0: MIT OR Apache-2.0
- serde 1.0.229: MIT OR Apache-2.0
- serialize-to-javascript-impl 0.1.2: MIT OR Apache-2.0
- serialize-to-javascript 0.1.2: MIT OR Apache-2.0
- servo_arc 0.4.3: MIT OR Apache-2.0
- sha1 0.10.7: MIT OR Apache-2.0
- sha2 0.10.9: MIT OR Apache-2.0
- shared_child 1.1.1: MIT
- sigchld 0.2.4: MIT (macOS only)
- signal-hook-registry 1.4.8: MIT OR Apache-2.0 (macOS only)
- signal-hook 0.3.18: Apache-2.0 OR MIT (macOS only)
- simd-adler32 0.3.10: MIT
- siphasher 1.0.3: MIT OR Apache-2.0
- slab 0.4.12: MIT
- smallvec 1.15.2: MIT OR Apache-2.0
- socket2 0.6.5: MIT OR Apache-2.0
- softbuffer 0.4.8: MIT OR Apache-2.0 (Windows only)
- stable_deref_trait 1.2.1: MIT OR Apache-2.0
- string_cache 0.9.0: MIT OR Apache-2.0
- strsim 0.11.1: MIT
- subtle 2.6.1: BSD-3-Clause
- swift-rs 1.0.8: MIT OR Apache-2.0 (macOS only)
- sync_wrapper 1.0.2: Apache-2.0
- synstructure 0.13.2: MIT
- syn 2.0.119: MIT OR Apache-2.0
- syn 3.0.4: MIT OR Apache-2.0
- system-configuration-sys 0.6.0: MIT OR Apache-2.0 (macOS only)
- system-configuration 0.7.0: MIT OR Apache-2.0 (macOS only)
- tao 0.35.3: Apache-2.0
- tauri-codegen 2.6.3: Apache-2.0 OR MIT
- tauri-macros 2.6.3: Apache-2.0 OR MIT
- tauri-plugin-shell 2.3.5: Apache-2.0 OR MIT
- tauri-runtime-wry 2.11.4: Apache-2.0 OR MIT
- tauri-runtime 2.11.3: Apache-2.0 OR MIT
- tauri-utils 2.9.3: Apache-2.0 OR MIT
- tauri 2.11.5: Apache-2.0 OR MIT
- tempfile 3.27.0: MIT OR Apache-2.0 (macOS only)
- tendril 0.5.1: MIT OR Apache-2.0
- thiserror-impl 1.0.69: MIT OR Apache-2.0
- thiserror-impl 2.0.20: MIT OR Apache-2.0
- thiserror 1.0.69: MIT OR Apache-2.0
- thiserror 2.0.20: MIT OR Apache-2.0
- time-core 0.1.9: MIT OR Apache-2.0
- time-macros 0.2.32: MIT OR Apache-2.0
- time 0.3.55: MIT OR Apache-2.0
- tinystr 0.8.4: Unicode-3.0
- tinyvec_macros 0.1.1: MIT OR Apache-2.0 OR Zlib
- tinyvec 1.12.0: Zlib OR Apache-2.0 OR MIT
- tokio-macros 2.7.2: MIT
- tokio-native-tls 0.3.1: MIT
- tokio-rustls 0.26.4: MIT OR Apache-2.0
- tokio-util 0.7.19: MIT
- tokio 1.53.1: MIT
- toml_datetime 1.1.1+spec-1.1.0: MIT OR Apache-2.0
- toml_parser 1.1.3+spec-1.1.0: MIT OR Apache-2.0
- toml_writer 1.1.2+spec-1.1.0: MIT OR Apache-2.0
- toml 1.1.4+spec-1.1.0: MIT OR Apache-2.0
- tower-http 0.6.11: MIT
- tower-layer 0.3.3: MIT
- tower-service 0.3.3: MIT
- tower 0.5.3: MIT
- tracing-core 0.1.36: MIT
- tracing 0.1.44: MIT
- tray-icon 0.24.2: MIT OR Apache-2.0
- try-lock 0.2.5: MIT
- typeid 1.0.3: MIT OR Apache-2.0
- typenum 1.20.1: MIT OR Apache-2.0
- unic-char-property 0.9.0: MIT OR Apache-2.0
- unic-char-range 0.9.0: MIT OR Apache-2.0
- unic-common 0.9.0: MIT OR Apache-2.0
- unic-ucd-ident 0.9.0: MIT OR Apache-2.0
- unic-ucd-version 0.9.0: MIT OR Apache-2.0
- unicode-ident 1.0.24: (MIT OR Apache-2.0) AND Unicode-3.0
- unicode-segmentation 1.13.3: MIT OR Apache-2.0
- untrusted 0.9.0: ISC
- urlpattern 0.3.0: MIT
- url 2.5.8: MIT OR Apache-2.0
- utf8_iter 1.0.4: Apache-2.0 OR MIT
- uuid 1.26.0: Apache-2.0 OR MIT
- walkdir 2.5.0: Unlicense OR MIT
- want 0.3.1: MIT
- web_atoms 0.2.6: MIT OR Apache-2.0
- webview2-com-macros 0.8.1: MIT (Windows only)
- webview2-com-sys 0.38.2: MIT (Windows only)
- webview2-com 0.38.2: MIT (Windows only)
- winapi-util 0.1.11: Unlicense OR MIT (Windows only)
- window-vibrancy 0.6.0: Apache-2.0 OR MIT
- windows-collections 0.2.0: MIT OR Apache-2.0 (Windows only)
- windows-core 0.61.2: MIT OR Apache-2.0 (Windows only)
- windows-future 0.2.1: MIT OR Apache-2.0 (Windows only)
- windows-implement 0.60.2: MIT OR Apache-2.0 (Windows only)
- windows-interface 0.59.3: MIT OR Apache-2.0 (Windows only)
- windows-link 0.1.3: MIT OR Apache-2.0 (Windows only)
- windows-link 0.2.1: MIT OR Apache-2.0 (Windows only)
- windows-numerics 0.2.0: MIT OR Apache-2.0 (Windows only)
- windows-registry 0.6.1: MIT OR Apache-2.0 (Windows only)
- windows-result 0.3.4: MIT OR Apache-2.0 (Windows only)
- windows-result 0.4.1: MIT OR Apache-2.0 (Windows only)
- windows-strings 0.4.2: MIT OR Apache-2.0 (Windows only)
- windows-strings 0.5.1: MIT OR Apache-2.0 (Windows only)
- windows-sys 0.59.0: MIT OR Apache-2.0 (Windows only)
- windows-sys 0.60.2: MIT OR Apache-2.0 (Windows only)
- windows-sys 0.61.2: MIT OR Apache-2.0 (Windows only)
- windows-targets 0.52.6: MIT OR Apache-2.0 (Windows only)
- windows-targets 0.53.5: MIT OR Apache-2.0 (Windows only)
- windows-threading 0.1.0: MIT OR Apache-2.0 (Windows only)
- windows-version 0.1.7: MIT OR Apache-2.0 (Windows only)
- windows_x86_64_msvc 0.52.6: MIT OR Apache-2.0 (Windows only)
- windows_x86_64_msvc 0.53.1: MIT OR Apache-2.0 (Windows only)
- windows 0.61.3: MIT OR Apache-2.0 (Windows only)
- winnow 1.0.4: MIT
- writeable 0.6.4: Unicode-3.0
- wry 0.55.1: Apache-2.0 OR MIT
- xz2 0.1.7: MIT OR Apache-2.0
- yoke-derive 0.8.2: Unicode-3.0
- yoke 0.8.3: Unicode-3.0
- zerofrom-derive 0.1.7: Unicode-3.0
- zerofrom 0.1.8: Unicode-3.0
- zeroize_derive 1.5.0: Apache-2.0 OR MIT
- zeroize 1.9.0: Apache-2.0 OR MIT
- zerotrie 0.2.5: Unicode-3.0
- zerovec-derive 0.11.6: Unicode-3.0
- zerovec 0.11.8: Unicode-3.0
- zip 2.4.2: MIT
- zlib-rs 0.6.7: Zlib
- zmij 1.0.23: MIT
- zopfli 0.8.3: Apache-2.0
- zstd-safe 7.2.4: MIT OR Apache-2.0
- zstd-sys 2.0.16+zstd.1.5.7: MIT OR Apache-2.0
- zstd 0.13.3: MIT

</details>

<details>
<summary>Copyright notices of the crates</summary>

- Copyright (C) Jonas Schievink [adler2]
- Copyright (c) 2018 Artyom Pavlov [aes]
- Copyright (c) 2015 Andrew Gallant [aho-corasick, byteorder, jiff, jiff-core, jiff-tzdb, jiff-tzdb-platform, memchr, walkdir]
- Copyright (c) 2016 Dropbox, Inc. [alloc-no-stdlib, brotli, brotli-decompressor]
- Copyright (c) the alloc-stdlib authors (Daniel Reiter Horn) [alloc-stdlib]
- Copyright (c) the anyhow authors (David Tolnay) [anyhow]
- Copyright (c) 2016 Alex Crichton [atomic-waker, futures-channel, futures-core, futures-io, futures-macro, futures-sink, futures-task, futures-util, lzma-sys, try-lock, xz2]
- Copyright (c) 2017 The Tokio Authors [atomic-waker, futures-channel, futures-core, futures-io, futures-macro, futures-sink, futures-task, futures-util]
- Copyright (c) 2015 Alice Maz [base64]
- Copyright (c) 2023 The Rust Project Developers [bit-set, bit-vec]
- Copyright (c) 2014 The Rust Project Developers [bitflags, getrandom, glob, log, num-traits, regex, regex-automata, regex-syntax, uuid]
- Copyright (c) 2018-2019 The RustCrypto Project Developers [block-buffer]
- Copyright (c) the block2 authors (Mads Marquart) [block2]
- Copyright (c) 2009, 2010, 2013-2016 by the Brotli Authors. [brotli]
- Copyright (c) 2016 The roaring-rs developers. [bs58]
- Copyright (c) 2019 Nick Fitzgerald [bumpalo]
- Copyright (c) 2018 Carl Lerche [bytes]
- Copyright (c) 2014-2025 Alex Crichton and Contributors [bzip2, bzip2-sys]
- Copyright (c) the camino authors (Without Boats, Ashley Williams, Steve Klabnik, Rain) [camino]
- Copyright (c) the cargo-platform authors [cargo-platform]
- Copyright (c) the cargo_metadata authors (Oliver Schneider) [cargo_metadata]
- Copyright (c) 2017 Matthew D. Steele [cfb]
- Copyright (c) 2014 Alex Crichton [cfg-if, cookie, socket2]
- Copyright (c) 2014, Kang Seonghoon. [chrono]
- Copyright (c) 2016-2020 RustCrypto Developers [cipher]
- Copyright (c) the constant_time_eq authors (Cesar Eduardo Barros) [constant_time_eq]
- Copyright 2017 Sergio Benitez [cookie]
- Copyright 2014 Alex Chricton [cookie]
- Copyright (c) 2017 Sergio Benitez [cookie]
- Copyright (c) 2012-2013 Mozilla Foundation [core-foundation, core-foundation-sys, core-graphics, core-graphics-types, string_cache]
- Copyright (c) 2020-2025 The RustCrypto Project Developers [cpufeatures]
- Copyright (c) the crc-catalog authors (Akhil Velagapudi) [crc-catalog]
- Copyright (c) 2018 Sam Rijs, Alex Crichton and contributors [crc32fast]
- Copyright (c) 2017 crc-rs Developers [crc]
- Copyright (c) 2019 The Crossbeam Project Developers [crossbeam-channel, crossbeam-utils]
- Copyright (c) 2009 The Go Authors. All rights reserved. [crossbeam-channel, ring]
- Copyright (c) 2021 RustCrypto Developers [crypto-common]
- Copyright (c) the cssparser-macros authors (Simon Sapin) [cssparser-macros]
- Copyright (c) the cssparser authors (Simon Sapin) [cssparser]
- Copyright (c) the ctor-proc-macro authors (Matt Mastracci) [ctor-proc-macro]
- Copyright (c) the ctor authors (Matt Mastracci) [ctor]
- Copyright (c) 2017 Ted Driggs [darling, darling_core, darling_macro]
- Copyright (c) .NET Foundation and Contributors [deflate64]
- Copyright (c) anatawa12 2023 [deflate64]
- Copyright (c) Ferrous Systems [defmt, defmt-macros]
- Copyright (c) the defmt-parser authors (The Knurling-rs developers) [defmt-parser]
- Copyright 2024 Jacob Pratt et al. [deranged]
- Copyright (c) 2024 Jacob Pratt et al. [deranged]
- Copyright (c) 2016 Jelte Fennema [derive_more, derive_more-impl]
- Copyright (c) 2017 Artyom Pavlov [digest, hmac, pbkdf2]
- Copyright (c) 2018-2019 dirs-rs contributors [dirs, dirs-sys]
- Copyright (c) the dispatch2 authors (Mads Marquart, Mary) [dispatch2]
- Copyright (c) the displaydoc authors (Jane Lusby) [displaydoc]
- Copyright (c) 2023 Mykola Humanov [dom_query]
- Copyright (c) 2018 Jorge Aparicio [dpi]
- Copyright (c) 2005-2020 Rich Felker, et al. [dpi]
- Copyright (c) 2017-2018 Arm Limited [dpi]
- Copyright (c) the dtoa-short authors (Xidorn Quan) [dtoa-short]
- Copyright (c) the dtoa authors (David Tolnay) [dtoa]
- Copyright (c) the dtor-proc-macro authors (Matt Mastracci) [dtor-proc-macro]
- Copyright (c) the dtor authors (Matt Mastracci) [dtor]
- Copyright (c) the dunce authors (Kornel) [dunce]
- Copyright (c) the dyn-clone authors (David Tolnay) [dyn-clone]
- Copyright (c) 2020 Nikolai Vazquez [embed_plist]
- Copyright Mozilla Foundation [encoding_rs, utf8_iter]
- Copyright (c) WHATWG (Apple, Google, Mozilla, Microsoft). [encoding_rs]
- Copyright (c) the equivalent authors [equivalent]
- Copyright (c) the erased-serde authors (David Tolnay) [erased-serde]
- Copyright (c) 2014 Chris Wong [errno]
- Copyright (c) the fastrand authors (Stjepan Glavina) [fastrand]
- Copyright (c) the fdeflate authors (The image-rs Developers) [fdeflate]
- Copyright (c) 2014-2026 Alex Crichton [flate2]
- Copyright (c) 2017 Contributors [fnv]
- Copyright (c) 2024 Orson Peters [foldhash]
- Copyright (c) 2017 The foreign-types Developers [foreign-types, foreign-types-macros, foreign-types-shared]
- Copyright (c) 2013-2016 The rust-url developers [form_urlencoded]
- Copyright (c) 2015 Bartłomiej Kamiński [generic-array]
- Copyright (c) 2018-2024 The rust-random Project Developers [getrandom]
- Copyright (c) 2018-2025 The rust-random Project Developers [getrandom]
- Copyright (c) 2018-2026 The rust-random Project Developers [getrandom]
- Copyright (c) 2017 h2 authors [h2]
- Copyright (c) 2016 Amanieu d'Antras [hashbrown]
- Copyright (c) 2015 The Rust Project Developers [heck, unicode-segmentation]
- Copyright (c) 2013-2014 The Rust Project Developers. [hex]
- Copyright (c) 2015-2020 The rust-hex Developers [hex]
- Copyright (c) 2014 The html5ever Project Developers [html5ever, markup5ever, web_atoms]
- Copyright (c) 2019-2026 Sean McArthur & Hyper Contributors [http-body, http-body-util]
- Copyright (c) 2015-2025 Sean McArthur [httparse]
- Copyright 2017 http-rs authors [http]
- Copyright (c) 2017 http-rs authors [http]
- Copyright (c) 2016, Joseph Birr-Pixton [hyper-rustls, rustls]
- Copyright (c) 2016 Joseph Birr-Pixton [hyper-rustls, rustls]
- Copyright (c) 2017 Sean McArthur [hyper-tls]
- Copyright (c) 2023-2025 Sean McArthur [hyper-util]
- Copyright (c) 2014-2026 Sean McArthur [hyper]
- Copyright 2020 Andrew Straw [iana-time-zone]
- Copyright (c) 2020 Andrew D. Straw [iana-time-zone]
- Copyright (c) 2018 Matthew D. Steele [ico]
- Copyright (c) 2020-2024 Unicode, Inc. [icu_collections, icu_locale_core, icu_normalizer, icu_normalizer_data, icu_properties, icu_properties_data, icu_provider, litemap, potential_utf, tinystr, writeable, yoke, yoke-derive, zerofrom, zerofrom-derive, zerotrie, zerovec, zerovec-derive]
- Copyright (c) the ident_case authors (Ted Driggs) [ident_case]
- Copyright (c) The rust-url developers [idna_adapter]
- Copyright (c) 2013-2025 The rust-url developers [idna, percent-encoding, url]
- Copyright (c) the indexmap authors [indexmap]
- Copyright (c) 2019 Bojan [infer]
- Copyright (c) 2022 The RustCrypto Project Developers [inout]
- Copyright (c) 2022 Artyom Pavlov [inout]
- Copyright 2017 Juniper Networks, Inc. [ipnet]
- Copyright (c) the itoa authors (David Tolnay) [itoa]
- Copyright (c) 2017 Ivan Dubrov [json-patch]
- Copyright 2024 Chance Dinkins [jsonptr]
- Copyright (c) 2022 Chance Dinkins [jsonptr]
- Copyright (c) 2017 Pyfisch [keyboard-types]
- Copyright (c) The Rust Project Developers [libc]
- Copyright (c) 2016 The Rust Project Developers [lock_api, parking_lot, parking_lot_core]
- Copyright (c) 2017 - 2018  Guillaume Endignoux [lzma-rs]
- Copyright (c) 2014 Sean McArthur [mime]
- Copyright 2013-2014 RAD Game Tools and Valve Software [miniz_oxide]
- Copyright 2010-2014 Rich Geldreich and Tenacious Software LLC [miniz_oxide]
- Copyright (c) 2017 Frommi [miniz_oxide]
- Copyright (c) 2017-2024 oyvindln [miniz_oxide]
- Copyright (c) 2020 Frommi [miniz_oxide]
- Copyright (c) 2014 Carl Lerche and other MIO contributors [mio]
- Copyright (c) 2022-2022 Tauri Programme within The Commons Conservancy [muda, tray-icon]
- Copyright (c) 2016 The rust-native-tls Developers [native-tls]
- Copyright (c) 2015 Jonathan Reem [new_debug_unreachable]
- Copyright (c) Jacob Pratt [num-conv]
- Copyright (c) the objc2-app-kit authors [objc2-app-kit]
- Copyright (c) the objc2-core-foundation authors [objc2-core-foundation]
- Copyright (c) the objc2-core-graphics authors [objc2-core-graphics]
- Copyright (c) the objc2-encode authors (Mads Marquart) [objc2-encode]
- Copyright (c) the objc2-exception-helper authors (Mads Marquart) [objc2-exception-helper]
- Copyright (c) the objc2-foundation authors [objc2-foundation]
- Copyright (c) the objc2-io-surface authors [objc2-io-surface]
- Copyright (c) the objc2-web-kit authors [objc2-web-kit]
- Copyright (c) the objc2 authors (Mads Marquart) [objc2]
- Copyright (c) the once_cell authors (Aleksey Kladov) [once_cell]
- Copyright (c) `2015` `Sebastian Thiel` [open]
- Copyright (c) the option-ext authors (Simon Ochsenreither) [option-ext]
- Copyright (c) the os_pipe authors (Jack O'Connor) [os_pipe]
- Copyright (c) 2018-2023 The RustCrypto Project Developers [pbkdf2]
- Copyright (c) 2014-2022 Steven Fackler, Yuki Okushi [phf, phf_generator, phf_macros, phf_shared]
- Copyright (c) the pin-project-lite authors [pin-project-lite]
- Copyright (c) 2015 Edward Barnard [plist]
- Copyright (c) 2015 nwin [png]
- Copyright 2023 Jacob Pratt et al. [powerfmt]
- Copyright (c) 2023 Jacob Pratt et al. [powerfmt]
- Copyright (c) 2017 Emilio Cobos Álvarez [precomputed-hash]
- Copyright (c) the proc-macro2 authors (David Tolnay, Alex Crichton) [proc-macro2]
- Copyright (c) 2016 Johann Tuffe [quick-xml]
- Copyright (c) the quote authors (David Tolnay) [quote]
- Copyright (c) 2019 Osspial [raw-window-handle]
- Copyright (c) 2020 Osspial [raw-window-handle]
- Copyright (c) the ref-cast-impl authors (David Tolnay) [ref-cast-impl]
- Copyright (c) the ref-cast authors (David Tolnay) [ref-cast]
- Copyright 2016 Sean McArthur [reqwest]
- Copyright (c) 2016-2025 Sean McArthur [reqwest]
- Copyright 2015 The Chromium Authors. All rights reserved. [ring]
- Copyright 2015-2025 Brian Smith. [ring]
- Copyright (c) the rustc-hash authors (The Rust Project Developers) [rustc-hash]
- Copyright (c) the rustix authors (Dan Gohman, Jakub Konka) [rustix]
- Copyright 2023 Dirkjan Ochtman [rustls-pki-types]
- Copyright (c) 2023 Dirkjan Ochtman [rustls-pki-types]
- Copyright 2015 Brian Smith. [rustls-webpki]
- Copyright (c) the ryu authors (David Tolnay) [ryu]
- Copyright (c) 2017 Andrew Gallant [same-file, winapi-util]
- Copyright (c) 2015 steffengy [schannel]
- Copyright (c) 2019 Graham Esau [schemars, schemars_derive]
- Copyright (c) 2016-2019 Ulrik Sverdrup "bluss" and scopeguard developers [scopeguard]
- Copyright (c) 2015 Steven Fackler [security-framework, security-framework-sys]
- Copyright (c) the selectors authors (The Servo Project Developers) [selectors]
- Copyright (c) the semver authors (David Tolnay) [semver]
- Copyright (c) the serde-untagged authors (David Tolnay) [serde-untagged]
- Copyright (c) the serde_core authors (Erick Tryzelaar, David Tolnay) [serde_core]
- Copyright (c) the serde_derive_internals authors (Erick Tryzelaar, David Tolnay) [serde_derive_internals]
- Copyright (c) the serde_derive authors (Erick Tryzelaar, David Tolnay) [serde_derive]
- Copyright (c) the serde_json authors (Erick Tryzelaar, David Tolnay) [serde_json]
- Copyright (c) the serde_repr authors (David Tolnay) [serde_repr]
- Copyright (c) Individual contributors [serde_spanned, toml, toml_datetime, toml_parser, toml_writer]
- Copyright (c) 2016 Anthony Ramine [serde_urlencoded]
- Copyright (c) the serde_with_macros authors (Jonas Bushart) [serde_with_macros]
- Copyright (c) the serde_with authors (Jonas Bushart, Marcin Kaźmierczak) [serde_with]
- Copyright (c) the serde authors (Erick Tryzelaar, David Tolnay) [serde]
- Copyright (c) 2021 Chip Reed [serialize-to-javascript, serialize-to-javascript-impl]
- Copyright (c) the servo_arc authors (The Servo Project Developers) [servo_arc]
- Copyright (c) 2006-2009 Graydon Hoare [sha1, sha2]
- Copyright (c) 2009-2013 Mozilla Foundation [sha1, sha2]
- Copyright (c) 2016 Artyom Pavlov [sha1, sha2]
- Copyright (c) the shared_child authors (jacko) [shared_child]
- Copyright (c) the sigchld authors (Jack O'Connor) [sigchld]
- Copyright (c) 2017 tokio-jsonrpc developers [signal-hook, signal-hook-registry]
- Copyright (c) [2021] [Marvin Countryman] [simd-adler32]
- Copyright 2012-2016 The Rust Project Developers. [siphasher]
- Copyright 2016-2026 Frank Denis. [siphasher]
- Copyright (c) 2019 Carl Lerche [slab]
- Copyright (c) 2018 The Servo Project Developers [smallvec]
- Copyright 2022 Kirill Chibisov [softbuffer]
- Copyright (c) 2017 Robert Grosse [stable_deref_trait]
- Copyright (c) 2015 Danny Guo [strsim]
- Copyright (c) 2016 Titus Wormer [strsim]
- Copyright (c) 2018 Akash Kurdekar [strsim]
- Copyright (c) 2016-2017 Isis Agora Lovecruft, Henry de Valence. All rights reserved. [subtle]
- Copyright (c) 2016-2024 Isis Agora Lovecruft. All rights reserved. [subtle]
- Copyright 2023 The swift-rs developers [swift-rs]
- Copyright (c) 2023 The swift-rs Developers [swift-rs]
- Copyright (c) the sync_wrapper authors (Actyx AG) [sync_wrapper]
- Copyright 2016 Nika Layzell [synstructure]
- Copyright (c) the syn authors (David Tolnay) [syn]
- Copyright (c) 2024 Mullvad VPN AB [system-configuration, system-configuration-sys]
- Copyright (c) the tao authors (Tauri Programme within The Commons Conservancy, The winit contributors) [tao]
- Copyright (c) 2017 - Present Tauri Apps Contributors [tauri, tauri-codegen, tauri-macros, tauri-plugin-shell, tauri-runtime, tauri-runtime-wry, tauri-utils]
- Copyright (c) 2015 Steven Allen [tempfile]
- Copyright (c) 2015 Keegan McAllister [tendril]
- Copyright (c) the thiserror-impl authors (David Tolnay) [thiserror-impl]
- Copyright (c) the thiserror authors (David Tolnay) [thiserror]
- Copyright (c) Jacob Pratt et al. [time, time-core, time-macros]
- Copyright 2020 Tomasz "Soveu" Marx [tinyvec_macros]
- Copyright (c) 2020 Soveu [tinyvec_macros]
- Copyright (c) 2019 Daniel "Lokathor" Gee. [tinyvec]
- Copyright (c) 2019 Yoshua Wuyts [tokio-macros]
- Copyright (c) Tokio Contributors [tokio, tokio-macros, tokio-util]
- Copyright (c) 2019 Tokio Contributors [tokio-native-tls, tracing, tracing-core]
- Copyright 2017 quininer kel [tokio-rustls]
- Copyright (c) 2017 quininer kel [tokio-rustls]
- Copyright (c) 2019-2021 Tower Contributors [tower-http]
- Copyright (c) 2019 Tower Contributors [tower, tower-layer, tower-service]
- Copyright (c) 2018-2023 Sean McArthur [try-lock]
- Copyright (c) the typeid authors (David Tolnay) [typeid]
- Copyright 2014 Paho Lurie-Gregg [typenum]
- Copyright (c) 2014 Paho Lurie-Gregg [typenum]
- Copyright (c) the unic-char-property authors (The UNIC Project Developers) [unic-char-property]
- Copyright (c) the unic-char-range authors (The UNIC Project Developers) [unic-char-range]
- Copyright (c) the unic-common authors (The UNIC Project Developers) [unic-common]
- Copyright (c) the unic-ucd-ident authors (The UNIC Project Developers) [unic-ucd-ident]
- Copyright (c) the unic-ucd-version authors (The UNIC Project Developers) [unic-ucd-version]
- Copyright (c) 1991-2023 Unicode, Inc. [unicode-ident]
- Copyright 2015-2016 Brian Smith. [untrusted]
- Copyright (c) 2021 the Deno authors [urlpattern]
- Copyright (c) 2018 Ashley Mannix, Christopher Armstrong, Dylan DPC, Hunar Roop Kahlon [uuid]
- Copyright (c) 2018-2019 Sean McArthur [want]
- Copyright (c) the webview2-com-macros authors [webview2-com-macros]
- Copyright (c) the webview2-com-sys authors [webview2-com-sys]
- Copyright (c) the webview2-com authors [webview2-com]
- Copyright (c) 2020-2022 Tauri Programme within The Commons Conservancy [window-vibrancy]
- Copyright (c) Microsoft Corporation. [windows, windows-collections, windows-core, windows-future, windows-implement, windows-interface, windows-link, windows-numerics, windows-registry, windows-result, windows-strings, windows-sys, windows-targets, windows-threading, windows-version, windows_x86_64_msvc]
- Copyright (c) the winnow authors [winnow]
- Copyright (c) 2020-2023 Ngo Iok Ui & Tauri Programme within The Commons Conservancy [wry]
- Copyright (c) 2019-2026 The RustCrypto Project Developers [zeroize_derive]
- Copyright (c) 2018-2026 The RustCrypto Project Developers [zeroize]
- Copyright (c) 2014 Mathijs van de Nes [zip]
- Copyright (c) the zlib-rs authors [zlib-rs]
- Copyright (c) the zmij authors (David Tolnay) [zmij]
- Copyright 2011 Google Inc. [zopfli]
- Copyright (c) 2016 Alexandre Bury [zstd, zstd-safe, zstd-sys]
- Copyright (c) 2016-present, Facebook, Inc. All rights reserved. [zstd-sys]

</details>

### Fonts

The desktop app's start screen comes with two fonts. Their licence files sit beside them in the app's `fonts` folder.

| Font | File | Licence | Source |
|---|---|---|---|
| Plus Jakarta Sans | `PlusJakartaSans-latin.woff2` | OFL-1.1 (`OFL-PlusJakartaSans.txt`), Copyright 2020 The Plus Jakarta Sans Project Authors | <https://github.com/tokotype/PlusJakartaSans> |
| JetBrains Mono | `JetBrainsMono-latin.woff2` | OFL-1.1 (`OFL-JetBrainsMono.txt`), Copyright 2020 The JetBrains Mono Project Authors | <https://github.com/JetBrains/JetBrainsMono> |

The studio and the Pack Builder load their fonts from Google Fonts instead of shipping them (see [PRIVACY.md](PRIVACY.md)).

### Icons

Many of DubMate's icons come from Lucide. Licence: ISC, Copyright (c) 2026 Lucide Icons and Contributors. The icons Lucide took from Feather are MIT, Copyright (c) 2013-present Cole Bemis. Source: <https://github.com/lucide-icons/lucide>.

## 2. Downloaded when you install the Pack Builder

Ticking Pack Builder downloads these from PyPI onto your computer, with the packages they need in turn, each under its own licence. DubMate doesn't ship them. Versions are the newest allowed by `requirements_builder.txt` when you install.

| Package | Licence | Source |
|---|---|---|
| torch (PyTorch) | BSD-3-Clause AND BSD-2-Clause AND Apache-2.0 AND Apache-2.0 WITH LLVM-exception AND BSL-1.0 AND MIT | <https://github.com/pytorch/pytorch> |
| torchaudio | BSD-2-Clause | <https://github.com/pytorch/audio> |
| demucs | MIT | <https://github.com/adefossez/demucs> |
| openai-whisper | MIT | <https://github.com/openai/whisper> |
| pykakasi | GPL-3.0-or-later | <https://codeberg.org/miurahr/pykakasi> |
| yt-dlp | Unlicense | <https://github.com/yt-dlp/yt-dlp> |
| sherpa-onnx 1.13.8 | Apache-2.0 | <https://github.com/k2-fsa/sherpa-onnx> |

## 3. Models downloaded on first use

| Model | Used for | Licence | Downloaded from |
|---|---|---|---|
| Whisper `base` | Transcribing lines | MIT, Copyright (c) 2022 OpenAI | `openaipublic.azureedge.net`, by openai-whisper |
| Demucs `htdemucs` | Separating voices from music and effects | MIT, Copyright (c) Meta Platforms, Inc. and affiliates | `dl.fbaipublicfiles.com`, by demucs |
| pyannote segmentation 3.0, ONNX export (`pyannote-segmentation-3-0.onnx`) | Finding where each voice speaks | MIT, Copyright (c) 2022 CNRS. Its licence is saved beside it as `pyannote-segmentation-3-0.LICENSE` | <https://github.com/k2-fsa/sherpa-onnx/releases/tag/speaker-segmentation-models> |
| 3D-Speaker CAM++ (`campplus-sv-zh-en-16k-common-advanced.onnx`) | Telling voices apart | Apache-2.0, from the 3D-Speaker project (<https://github.com/modelscope/3D-Speaker>) | <https://github.com/k2-fsa/sherpa-onnx/releases/tag/speaker-recongition-models> |

## 4. Code adapted from other projects

- **pyloudnorm** (MIT, Copyright (c) 2018 Christian Steinmetz). DubMate's loudness measurement follows pyloudnorm's integrated loudness, ported to numpy, in `audio_processor.py`. Source: <https://github.com/csteinmetz1/pyloudnorm>.

## 5. Licence texts

Each licence text appears once. The copyright holders are listed with each component above. The GNU General Public License v3 is in [LICENSE](LICENSE).

### MIT License

```
Copyright (c) <year> <copyright holders>

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

### BSD 3-Clause License

```
Copyright (c) <year>, <copyright holders>

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are met:

1. Redistributions of source code must retain the above copyright notice, this
   list of conditions and the following disclaimer.

2. Redistributions in binary form must reproduce the above copyright notice,
   this list of conditions and the following disclaimer in the documentation
   and/or other materials provided with the distribution.

3. Neither the name of the copyright holder nor the names of its
   contributors may be used to endorse or promote products derived from
   this software without specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE
FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY,
OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
```

### ISC License

```
Copyright (c) <year> <copyright holders>

Permission to use, copy, modify, and/or distribute this software for any
purpose with or without fee is hereby granted, provided that the above
copyright notice and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES
WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF
MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR
ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES
WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN
ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF
OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.
```

### zlib License

```
Copyright (c) <year> <copyright holders>

This software is provided 'as-is', without any express or implied warranty. In
no event will the authors be held liable for any damages arising from the use of
this software.

Permission is granted to anyone to use this software for any purpose, including
commercial applications, and to alter it and redistribute it freely, subject to
the following restrictions:

1. The origin of this software must not be misrepresented; you must not claim
   that you wrote the original software. If you use this software in a product,
   an acknowledgment in the product documentation would be appreciated but is
   not required.

2. Altered source versions must be plainly marked as such, and must not be
   misrepresented as being the original software.

3. This notice may not be removed or altered from any source distribution.
```

### Unicode License v3

```
UNICODE LICENSE V3

COPYRIGHT AND PERMISSION NOTICE

Copyright © 2020-2024 Unicode, Inc.

NOTICE TO USER: Carefully read the following legal agreement. BY
DOWNLOADING, INSTALLING, COPYING OR OTHERWISE USING DATA FILES, AND/OR
SOFTWARE, YOU UNEQUIVOCALLY ACCEPT, AND AGREE TO BE BOUND BY, ALL OF THE
TERMS AND CONDITIONS OF THIS AGREEMENT. IF YOU DO NOT AGREE, DO NOT
DOWNLOAD, INSTALL, COPY, DISTRIBUTE OR USE THE DATA FILES OR SOFTWARE.

Permission is hereby granted, free of charge, to any person obtaining a
copy of data files and any associated documentation (the "Data Files") or
software and any associated documentation (the "Software") to deal in the
Data Files or Software without restriction, including without limitation
the rights to use, copy, modify, merge, publish, distribute, and/or sell
copies of the Data Files or Software, and to permit persons to whom the
Data Files or Software are furnished to do so, provided that either (a)
this copyright and permission notice appear with all copies of the Data
Files or Software, or (b) this copyright and permission notice appear in
associated Documentation.

THE DATA FILES AND SOFTWARE ARE PROVIDED "AS IS", WITHOUT WARRANTY OF ANY
KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT OF
THIRD PARTY RIGHTS.

IN NO EVENT SHALL THE COPYRIGHT HOLDER OR HOLDERS INCLUDED IN THIS NOTICE
BE LIABLE FOR ANY CLAIM, OR ANY SPECIAL INDIRECT OR CONSEQUENTIAL DAMAGES,
OR ANY DAMAGES WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS,
WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION,
ARISING OUT OF OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THE DATA
FILES OR SOFTWARE.

Except as contained in this notice, the name of a copyright holder shall
not be used in advertising or otherwise to promote the sale, use or other
dealings in these Data Files or Software without prior written
authorization of the copyright holder.
```

### Python Software Foundation License Version 2

```
PYTHON SOFTWARE FOUNDATION LICENSE VERSION 2
--------------------------------------------

1. This LICENSE AGREEMENT is between the Python Software Foundation
("PSF"), and the Individual or Organization ("Licensee") accessing and
otherwise using this software ("Python") in source or binary form and
its associated documentation.

2. Subject to the terms and conditions of this License Agreement, PSF hereby
grants Licensee a nonexclusive, royalty-free, world-wide license to reproduce,
analyze, test, perform and/or display publicly, prepare derivative works,
distribute, and otherwise use Python alone or in any derivative version,
provided, however, that PSF's License Agreement and PSF's notice of copyright,
i.e., "Copyright (c) 2001, 2002, 2003, 2004, 2005, 2006, 2007, 2008, 2009, 2010,
2011, 2012, 2013, 2014, 2015, 2016, 2017, 2018, 2019, 2020, 2021, 2022, 2023 Python Software Foundation;
All Rights Reserved" are retained in Python alone or in any derivative version
prepared by Licensee.

3. In the event Licensee prepares a derivative work that is based on
or incorporates Python or any part thereof, and wants to make
the derivative work available to others as provided herein, then
Licensee hereby agrees to include in any such work a brief summary of
the changes made to Python.

4. PSF is making Python available to Licensee on an "AS IS"
basis.  PSF MAKES NO REPRESENTATIONS OR WARRANTIES, EXPRESS OR
IMPLIED.  BY WAY OF EXAMPLE, BUT NOT LIMITATION, PSF MAKES NO AND
DISCLAIMS ANY REPRESENTATION OR WARRANTY OF MERCHANTABILITY OR FITNESS
FOR ANY PARTICULAR PURPOSE OR THAT THE USE OF PYTHON WILL NOT
INFRINGE ANY THIRD PARTY RIGHTS.

5. PSF SHALL NOT BE LIABLE TO LICENSEE OR ANY OTHER USERS OF PYTHON
FOR ANY INCIDENTAL, SPECIAL, OR CONSEQUENTIAL DAMAGES OR LOSS AS
A RESULT OF MODIFYING, DISTRIBUTING, OR OTHERWISE USING PYTHON,
OR ANY DERIVATIVE THEREOF, EVEN IF ADVISED OF THE POSSIBILITY THEREOF.

6. This License Agreement will automatically terminate upon a material
breach of its terms and conditions.

7. Nothing in this License Agreement shall be deemed to create any
relationship of agency, partnership, or joint venture between PSF and
Licensee.  This License Agreement does not grant permission to use PSF
trademarks or trade name in a trademark sense to endorse or promote
products or services of Licensee, or any third party.

8. By copying, installing or otherwise using Python, Licensee
agrees to be bound by the terms and conditions of this License
Agreement.
```

### The Unlicense

```
This is free and unencumbered software released into the public domain.

Anyone is free to copy, modify, publish, use, compile, sell, or
distribute this software, either in source code form or as a compiled
binary, for any purpose, commercial or non-commercial, and by any
means.

In jurisdictions that recognize copyright laws, the author or authors
of this software dedicate any and all copyright interest in the
software to the public domain. We make this dedication for the benefit
of the public at large and to the detriment of our heirs and
successors. We intend this dedication to be an overt act of
relinquishment in perpetuity of all present and future rights to this
software under copyright law.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.
IN NO EVENT SHALL THE AUTHORS BE LIABLE FOR ANY CLAIM, DAMAGES OR
OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE,
ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR
OTHER DEALINGS IN THE SOFTWARE.

For more information, please refer to <https://unlicense.org/>
```

### Mozilla Public License 2.0

The full text is at <https://mozilla.org/MPL/2.0/>.

### SIL Open Font License 1.1

The full text ships beside each font, in `OFL-PlusJakartaSans.txt` and `OFL-JetBrainsMono.txt`, and is at <https://openfontlicense.org/>.

### GNU General Public License v2

The Rubber Band Library and FFTW, inside pedalboard, are GPL-2.0-or-later. DubMate uses them under version 3, in [LICENSE](LICENSE). Version 2 is at <https://www.gnu.org/licenses/old-licenses/gpl-2.0.html>.

### Apache License 2.0

```
                                 Apache License
                           Version 2.0, January 2004
                        http://www.apache.org/licenses/

   TERMS AND CONDITIONS FOR USE, REPRODUCTION, AND DISTRIBUTION

   1. Definitions.

      "License" shall mean the terms and conditions for use, reproduction,
      and distribution as defined by Sections 1 through 9 of this document.

      "Licensor" shall mean the copyright owner or entity authorized by
      the copyright owner that is granting the License.

      "Legal Entity" shall mean the union of the acting entity and all
      other entities that control, are controlled by, or are under common
      control with that entity. For the purposes of this definition,
      "control" means (i) the power, direct or indirect, to cause the
      direction or management of such entity, whether by contract or
      otherwise, or (ii) ownership of fifty percent (50%) or more of the
      outstanding shares, or (iii) beneficial ownership of such entity.

      "You" (or "Your") shall mean an individual or Legal Entity
      exercising permissions granted by this License.

      "Source" form shall mean the preferred form for making modifications,
      including but not limited to software source code, documentation
      source, and configuration files.

      "Object" form shall mean any form resulting from mechanical
      transformation or translation of a Source form, including but
      not limited to compiled object code, generated documentation,
      and conversions to other media types.

      "Work" shall mean the work of authorship, whether in Source or
      Object form, made available under the License, as indicated by a
      copyright notice that is included in or attached to the work
      (an example is provided in the Appendix below).

      "Derivative Works" shall mean any work, whether in Source or Object
      form, that is based on (or derived from) the Work and for which the
      editorial revisions, annotations, elaborations, or other modifications
      represent, as a whole, an original work of authorship. For the purposes
      of this License, Derivative Works shall not include works that remain
      separable from, or merely link (or bind by name) to the interfaces of,
      the Work and Derivative Works thereof.

      "Contribution" shall mean any work of authorship, including
      the original version of the Work and any modifications or additions
      to that Work or Derivative Works thereof, that is intentionally
      submitted to Licensor for inclusion in the Work by the copyright owner
      or by an individual or Legal Entity authorized to submit on behalf of
      the copyright owner. For the purposes of this definition, "submitted"
      means any form of electronic, verbal, or written communication sent
      to the Licensor or its representatives, including but not limited to
      communication on electronic mailing lists, source code control systems,
      and issue tracking systems that are managed by, or on behalf of, the
      Licensor for the purpose of discussing and improving the Work, but
      excluding communication that is conspicuously marked or otherwise
      designated in writing by the copyright owner as "Not a Contribution."

      "Contributor" shall mean Licensor and any individual or Legal Entity
      on behalf of whom a Contribution has been received by Licensor and
      subsequently incorporated within the Work.

   2. Grant of Copyright License. Subject to the terms and conditions of
      this License, each Contributor hereby grants to You a perpetual,
      worldwide, non-exclusive, no-charge, royalty-free, irrevocable
      copyright license to reproduce, prepare Derivative Works of,
      publicly display, publicly perform, sublicense, and distribute the
      Work and such Derivative Works in Source or Object form.

   3. Grant of Patent License. Subject to the terms and conditions of
      this License, each Contributor hereby grants to You a perpetual,
      worldwide, non-exclusive, no-charge, royalty-free, irrevocable
      (except as stated in this section) patent license to make, have made,
      use, offer to sell, sell, import, and otherwise transfer the Work,
      where such license applies only to those patent claims licensable
      by such Contributor that are necessarily infringed by their
      Contribution(s) alone or by combination of their Contribution(s)
      with the Work to which such Contribution(s) was submitted. If You
      institute patent litigation against any entity (including a
      cross-claim or counterclaim in a lawsuit) alleging that the Work
      or a Contribution incorporated within the Work constitutes direct
      or contributory patent infringement, then any patent licenses
      granted to You under this License for that Work shall terminate
      as of the date such litigation is filed.

   4. Redistribution. You may reproduce and distribute copies of the
      Work or Derivative Works thereof in any medium, with or without
      modifications, and in Source or Object form, provided that You
      meet the following conditions:

      (a) You must give any other recipients of the Work or
          Derivative Works a copy of this License; and

      (b) You must cause any modified files to carry prominent notices
          stating that You changed the files; and

      (c) You must retain, in the Source form of any Derivative Works
          that You distribute, all copyright, patent, trademark, and
          attribution notices from the Source form of the Work,
          excluding those notices that do not pertain to any part of
          the Derivative Works; and

      (d) If the Work includes a "NOTICE" text file as part of its
          distribution, then any Derivative Works that You distribute must
          include a readable copy of the attribution notices contained
          within such NOTICE file, excluding those notices that do not
          pertain to any part of the Derivative Works, in at least one
          of the following places: within a NOTICE text file distributed
          as part of the Derivative Works; within the Source form or
          documentation, if provided along with the Derivative Works; or,
          within a display generated by the Derivative Works, if and
          wherever such third-party notices normally appear. The contents
          of the NOTICE file are for informational purposes only and
          do not modify the License. You may add Your own attribution
          notices within Derivative Works that You distribute, alongside
          or as an addendum to the NOTICE text from the Work, provided
          that such additional attribution notices cannot be construed
          as modifying the License.

      You may add Your own copyright statement to Your modifications and
      may provide additional or different license terms and conditions
      for use, reproduction, or distribution of Your modifications, or
      for any such Derivative Works as a whole, provided Your use,
      reproduction, and distribution of the Work otherwise complies with
      the conditions stated in this License.

   5. Submission of Contributions. Unless You explicitly state otherwise,
      any Contribution intentionally submitted for inclusion in the Work
      by You to the Licensor shall be under the terms and conditions of
      this License, without any additional terms or conditions.
      Notwithstanding the above, nothing herein shall supersede or modify
      the terms of any separate license agreement you may have executed
      with Licensor regarding such Contributions.

   6. Trademarks. This License does not grant permission to use the trade
      names, trademarks, service marks, or product names of the Licensor,
      except as required for reasonable and customary use in describing the
      origin of the Work and reproducing the content of the NOTICE file.

   7. Disclaimer of Warranty. Unless required by applicable law or
      agreed to in writing, Licensor provides the Work (and each
      Contributor provides its Contributions) on an "AS IS" BASIS,
      WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or
      implied, including, without limitation, any warranties or conditions
      of TITLE, NON-INFRINGEMENT, MERCHANTABILITY, or FITNESS FOR A
      PARTICULAR PURPOSE. You are solely responsible for determining the
      appropriateness of using or redistributing the Work and assume any
      risks associated with Your exercise of permissions under this License.

   8. Limitation of Liability. In no event and under no legal theory,
      whether in tort (including negligence), contract, or otherwise,
      unless required by applicable law (such as deliberate and grossly
      negligent acts) or agreed to in writing, shall any Contributor be
      liable to You for damages, including any direct, indirect, special,
      incidental, or consequential damages of any character arising as a
      result of this License or out of the use or inability to use the
      Work (including but not limited to damages for loss of goodwill,
      work stoppage, computer failure or malfunction, or any and all
      other commercial damages or losses), even if such Contributor
      has been advised of the possibility of such damages.

   9. Accepting Warranty or Additional Liability. While redistributing
      the Work or Derivative Works thereof, You may choose to offer,
      and charge a fee for, acceptance of support, warranty, indemnity,
      or other liability obligations and/or rights consistent with this
      License. However, in accepting such obligations, You may act only
      on Your own behalf and on Your sole responsibility, not on behalf
      of any other Contributor, and only if You agree to indemnify,
      defend, and hold each Contributor harmless for any liability
      incurred by, or claims asserted against, such Contributor by reason
      of your accepting any such warranty or additional liability.

   END OF TERMS AND CONDITIONS
```
