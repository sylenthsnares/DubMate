; installer-hooks.nsh - DubMate Studio NSIS installer hooks
;
; The Pack Builder opt-in itself now lives in the custom NSIS template
; (installer.nsi) as a real, unchecked-by-default component on the components
; page, rather than a post-install message box. All that is left here is the
; uninstall cleanup, which the generated uninstaller cannot derive on its own.

!macro NSIS_HOOK_PREUNINSTALL
  ; The AI packages are several gigabytes and are downloaded after install, so the
  ; uninstaller's file list does not know about them. Remove them explicitly, along
  ; with the opt-in marker written by the Pack Builder component.
  RMDir /r "$INSTDIR\ai-packages"
  Delete "$INSTDIR\packbuilder.optin"
!macroend
