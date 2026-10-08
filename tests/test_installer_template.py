# -*- coding: utf-8 -*-
"""
test_installer_template.py
The Windows installer keeps Pack Builder and the user's DubMate data unless the user
asks for them to go (documentation/design/v2-installer.md, section 3).

Reads tauri/src-tauri/installer.nsi (the custom Tauri NSIS template) and
installer-hooks.nsh as text, so it runs on Linux CI without makensis:
- upgrading preselects "Do not uninstall";
- running a previous uninstaller passes /KEEPDATA and shields ai-packages and the
  Pack Builder choice around the ExecWait;
- the uninstall page offers "Also remove Pack Builder and my DubMate data", unticked;
- the uninstall hook removes nothing unless that box is ticked on a real uninstall;
- the installer and the launcher (paths.rs) agree on the folder and marker names.
"""

import json
import os
import re

PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TAURI = os.path.join(PROJECT_ROOT, "tauri", "src-tauri")


def _read(*parts):
    with open(os.path.join(TAURI, *parts), encoding="utf-8") as f:
        return f.read()


def _code(text):
    """The lines of an NSIS file without comments, stripped, blank lines dropped."""
    lines = []
    for line in text.splitlines():
        line = line.strip()
        if line and not line.startswith(";") and not line.startswith("#"):
            lines.append(line)
    return lines


def _between(lines, start, end):
    """The lines after the first one starting with `start`, up to one starting with `end`."""
    i = next(n for n, l in enumerate(lines) if l.startswith(start))
    j = next(n for n in range(i + 1, len(lines)) if lines[n].startswith(end))
    return lines[i + 1:j]


def _rust_const(name):
    m = re.search(r'const %s: &str = "([^"]+)";' % name, _read("src", "paths.rs"))
    assert m, f"paths.rs has no {name}"
    return m.group(1)


NSI = _code(_read("installer.nsi"))
HOOKS = _code(_read("installer-hooks.nsh"))


def test_upgrade_preselects_do_not_uninstall():
    page = _between(NSI, "Function PageReinstall", "FunctionEnd")
    upgrading = _between(page, "${ElseIf} $R0 = 1", "${ElseIf} $R0 = -1")
    assert "${If} $ReinstallPageCheck = 0" in upgrading, \
        "upgrading must only set the default on the first visit ($ReinstallPageCheck still 0)"
    first_visit = _between(upgrading, "${If} $ReinstallPageCheck = 0", "${EndIf}")
    assert first_visit == ["StrCpy $ReinstallPageCheck 2"], \
        "upgrading must preselect 'Do not uninstall' ($ReinstallPageCheck = 2)"
    same = _between(page, "${If} $R0 = 0", "${ElseIf} $R0 = 1")
    downgrade = _between(page, "${ElseIf} $R0 = -1", "${Else}")
    assert not any("ReinstallPageCheck" in l for l in same + downgrade), \
        "same-version and downgrade defaults must stay as they are"
    # The text above the choices doesn't recommend the other one (Tauri's line says
    # "It's recommended that you uninstall the current version before installing").
    assert upgrading[0] == ('StrCpy $R1 "An older version of DubMate is installed. '
                            'Installing over it keeps your rooms, settings and Pack Builder."'), upgrading[0]
    assert not any("olderOrUnknownVersionInstalled" in l for l in upgrading)
    # The radio that is checked is the one with keyboard focus.
    assert any(l.startswith("${NSD_SetFocus} $R3") for l in page), \
        "'Do not uninstall' must get the focus when it is the checked choice"
    print("[PASS] upgrading preselects 'Do not uninstall' on the first visit")


def test_previous_uninstaller_keeps_pack_builder():
    leave = _between(NSI, "Function PageLeaveReinstall", "FunctionEnd")
    block = _between(leave, "reinst_uninstall:", "reinst_done:")
    # The NSIS branch is the ExecWait that passes the uninstall directory (_?=).
    execs = [n for n, l in enumerate(block) if l.startswith("ExecWait '$R1' $0")]
    assert len(execs) == 2, "expected the WiX and the NSIS ExecWait"
    ex = execs[1]
    before, after = block[:ex], block[ex + 1:]
    branch_start = max(n for n, l in enumerate(before) if l == "${Else}")
    before = before[branch_start:]

    keep = next((l for l in before if l.startswith("StrCpy $R1 \"$R1 /KEEPDATA\"")), None)
    assert keep, "the previous uninstaller must get /KEEPDATA"
    assert before.index(keep) < next(n for n, l in enumerate(before) if "_?=" in l), \
        "/KEEPDATA must come before _?=, which has to be the last parameter"

    assert any(re.match(r'Rename "\$4\\ai-packages" "\$4\\ai-packages\.keep"', l) for l in before), \
        "ai-packages must be renamed to ai-packages.keep before the old uninstaller runs"
    assert any(re.match(r'CopyFiles /SILENT "\$4\\packbuilder\.optin" "\$PLUGINSDIR"', l) for l in before), \
        "the Pack Builder choice must be saved before the old uninstaller runs"
    assert "ClearErrors" in before[-3:], "a failed rename must not look like a failed uninstall"

    # Restored right after ExecWait, before any Abort can leave the page.
    first_abort = next(n for n, l in enumerate(after) if l.startswith("Abort") or "Abort ${|}" in l)
    restore = after[:first_abort]
    assert any(re.match(r'Rename "\$4\\ai-packages\.keep" "\$4\\ai-packages"', l) for l in restore), \
        "ai-packages.keep must be renamed back whatever the uninstaller returned"
    assert any(re.match(r'\$\{AndIfNot\} \$\{FileExists\} "\$4\\ai-packages\\\*\.\*"', l) for l in restore), \
        "the rename back must only happen when ai-packages is absent"
    assert any(re.match(r'CopyFiles /SILENT "\$PLUGINSDIR\\packbuilder\.optin" "\$4"', l) for l in restore), \
        "the Pack Builder choice must be put back"
    assert restore[0].startswith("${IfThen} ${Errors} ${|} StrCpy $0 2 ${|}"), \
        "the uninstaller's own result must be read before the restore touches the error flag"
    print("[PASS] a previous uninstaller runs with /KEEPDATA and ai-packages renamed out of its way")


def test_keepdata_switch():
    assert "Var KeepDataMode" in NSI, "KeepDataMode must be declared"
    declared = NSI.index("Var KeepDataMode")
    assert declared < NSI.index("Section Uninstall"), "declare KeepDataMode before the hook is inserted"
    init = _between(NSI, "Function un.onInit", "FunctionEnd")
    assert '${GetOptions} $CMDLINE "/KEEPDATA" $KeepDataMode' in init, "un.onInit must read /KEEPDATA"
    i = init.index('${GetOptions} $CMDLINE "/KEEPDATA" $KeepDataMode')
    assert init[i + 1:i + 4] == ["${IfNot} ${Errors}", "StrCpy $KeepDataMode 1", "${EndIf}"]
    # GetOptions matches an option as a prefix, so no switch may be a prefix of another.
    options = set(re.findall(r'\$\{GetOptions\} \$CMDLINE "(/[A-Z]+)"', "\n".join(NSI)))
    for other in options - {"/KEEPDATA"}:
        assert not "/KEEPDATA".startswith(other) and not other.startswith("/KEEPDATA"), \
            f"/KEEPDATA and {other} would match each other"
    print("[PASS] the uninstaller reads /KEEPDATA, which no other switch can match")


def test_uninstall_page_choice():
    show = _between(NSI, "Function un.ConfirmShow", "FunctionEnd")
    assert show[:4] == ["${If} $UpdateMode = 1", "${OrIf} $KeepDataMode = 1", "Return", "${EndIf}"], \
        "no tick-box when updating or reinstalling"
    text = "\n".join(show)
    assert 'w "Also remove Pack Builder and my DubMate data"' in text, "the tick-box label"
    assert "StrCpy $9 \"Rooms, takes, videos and settings in DubMate's own folder. Your scene packs are kept.\"" in show, \
        "the line under the tick-box"
    assert "__NSD_Label_CLASS" in text, "the second line is static text"
    assert "BM_SETCHECK" not in text, "the tick-box starts unticked"
    leave = _between(NSI, "Function un.ConfirmLeave", "FunctionEnd")
    assert leave[0] == '${If} $DeleteAppDataCheckbox != ""', "only read the tick-box when it was created"
    print("[PASS] the uninstall page offers 'Also remove Pack Builder and my DubMate data', unticked")


def test_hook_removes_only_when_asked():
    body = _between(HOOKS, "!macro NSIS_HOOK_PREUNINSTALL", "!macroend")
    assert body[:3] == [
        "${If} $DeleteAppDataCheckboxState = 1",
        "${AndIf} $UpdateMode <> 1",
        "${AndIf} $KeepDataMode <> 1",
    ], "the hook must be guarded by the tick-box, /UPDATE and /KEEPDATA"
    assert body[-1] == "${EndIf}", "the guard must close at the end of the hook"
    depth, removals = 0, []
    for line in body:
        if line.startswith("${If}"):
            depth += 1
        elif line.startswith("${EndIf}"):
            depth -= 1
        elif re.match(r"(RMDir|Delete)\b", line, re.I):
            assert depth >= 1, f"{line} runs outside the guard"
            removals.append(line)
    assert depth == 0
    assert "SetShellVarContext current" in body

    def guarded_by(target, check):
        i = body.index(f'RMDir /r "{target}"')
        assert body[i - 1] == f'${{If}} {check} != ""' and body[i + 1] == "${EndIf}", \
            f"{target} must only be removed when {check} is not empty"

    folder = _rust_const("APP_DATA_FOLDER")
    guarded_by(f"$LOCALAPPDATA\\{folder}", "$LOCALAPPDATA")
    guarded_by("$PROFILE\\.dubmate", "$PROFILE")
    for target in ("ai-packages", "ai-packages.keep", "data"):
        assert f'RMDir /r "$INSTDIR\\{target}"' in removals, f"{target} left behind by 1.x"
    assert 'Delete "$INSTDIR\\packbuilder.optin"' in removals
    assert not any("Packs" in l for l in removals), "scene packs are never removed"
    print("[PASS] the uninstall hook removes data only when the box is ticked on a real uninstall")


def test_installer_and_launcher_agree():
    folder = _rust_const("APP_DATA_FOLDER")
    marker = _rust_const("PACKBUILDER_OPTIN_MARKER")
    packages = _rust_const("AI_PACKAGES_DIR")
    new_marker = f"$LOCALAPPDATA\\{folder}\\{marker}"
    old_marker = f"$INSTDIR\\{marker}"

    section = _between(NSI, 'Section /o "Pack Builder', "SectionEnd")
    assert f'CreateDirectory "$LOCALAPPDATA\\{folder}"' in section
    assert f'FileOpen $0 "{new_marker}" w' in section, "the Pack Builder choice goes to the data folder"

    default = _between(NSI, "Function InitPackBuilderDefault", "FunctionEnd")
    assert f'${{If}} ${{FileExists}} "{new_marker}"' in default
    assert f'${{OrIf}} ${{FileExists}} "{old_marker}"' in default, "a 1.x choice still counts"

    main = _between(NSI, 'Section "!${PRODUCTNAME}" SecMain', "SectionEnd")
    assert f'Delete "{new_marker}"' in main and f'Delete "{old_marker}"' in main, \
        "the main section drops both stale markers"

    assert f'RMDir /r "$INSTDIR\\{packages}"' in HOOKS
    # $LOCALAPPDATA is this user's only in a per-user install, the folder paths.rs reads.
    conf = json.loads(_read("tauri.conf.json"))
    assert conf["bundle"]["windows"]["nsis"]["installMode"] == "currentUser"
    # The default install folder is $LOCALAPPDATA\<productName>: never the data folder.
    assert conf["productName"] != folder
    print(f"[PASS] the installer and paths.rs agree on {folder}\\{marker}")


if __name__ == "__main__":
    test_upgrade_preselects_do_not_uninstall()
    test_previous_uninstaller_keeps_pack_builder()
    test_keepdata_switch()
    test_uninstall_page_choice()
    test_hook_removes_only_when_asked()
    test_installer_and_launcher_agree()
    print("\n[OK] Installer template suite passed")
