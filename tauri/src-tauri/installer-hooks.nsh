; installer-hooks.nsh - DubMate Studio NSIS installer hooks
;
; The Pack Builder opt-in itself now lives in the custom NSIS template
; (installer.nsi) as a real, unchecked-by-default component on the components
; page, rather than a post-install message box. All that is left here is the
; uninstall cleanup, which the generated uninstaller cannot derive on its own.
;
; This file is included at the top of installer.nsi, but a macro body is only read
; where it is inserted (Section Uninstall), after the template declares the
; variables it uses: $DeleteAppDataCheckboxState, $UpdateMode and $KeepDataMode.

!macro NSIS_HOOK_PREUNINSTALL
  ; Pack Builder (several gigabytes, downloaded after install) and the user's rooms,
  ; takes and videos are removed only when the user ticks "Also remove Pack Builder
  ; and my DubMate data" on a real uninstall: never on an update (/UPDATE) or when the
  ; installer runs this uninstaller before reinstalling (/KEEPDATA).
  ;
  ; The DubMate data folder is the one paths.rs (user_data_root) and
  ; dubmate/data_home.py use. The $INSTDIR items are what 1.x kept there, if the move
  ; to the data folder hasn't happened or didn't finish. $PROFILE\.dubmate holds the
  ; settings. Scene packs and a chosen export folder are never removed.
  ${If} $DeleteAppDataCheckboxState = 1
  ${AndIf} $UpdateMode <> 1
  ${AndIf} $KeepDataMode <> 1
    ; installMode is currentUser, so this doesn't change the uninstaller's context.
    SetShellVarContext current
    ${If} $LOCALAPPDATA != ""
      RMDir /r "$LOCALAPPDATA\DubMate"
    ${EndIf}
    RMDir /r "$INSTDIR\ai-packages"
    RMDir /r "$INSTDIR\ai-packages.keep"
    RMDir /r "$INSTDIR\data"
    Delete "$INSTDIR\packbuilder.optin"
    ${If} $PROFILE != ""
      RMDir /r "$PROFILE\.dubmate"
    ${EndIf}
  ${EndIf}
!macroend
