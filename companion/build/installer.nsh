; ============================================================
; installer.nsh -- custom NSIS hook, picked up automatically by
; electron-builder (defaults to build/installer.nsh, see
; https://www.electron.build/nsis#custom-nsis-script).
;
; electron-builder already tries to close a running copy of the app before
; installing (its CHECK_APP_RUNNING macro: graceful taskkill, wait, then a
; forced retry) -- but in practice a user still had to hunt down and kill a
; leftover RaidLead Companion process in Task Manager by hand before the
; installer would proceed. RaidLead Companion is a lightweight tray sync
; helper with no unsaved state to protect (everything it holds is either
; already flushed to disk via config.save() or safely re-fetched on next
; launch), so there's no reason to give it the careful graceful-shutdown
; treatment other apps need. customInit runs at the very start of the
; installer, before any of that -- just unconditionally force-close it.
;
; InitPluginsDir first is required, not decorative: customInit runs inside
; .onInit before NSIS has extracted its plugin DLLs anywhere else in the
; default template, so nsExec::Exec silently did nothing without it --
; confirmed the hard way, this shipped once already and still hit
; electron-builder's own "cannot be closed" fallback dialog because the
; kill attempt never actually ran.
; ============================================================
!macro customInit
  InitPluginsDir
  nsExec::Exec 'taskkill /f /im "${APP_EXECUTABLE_FILENAME}"'
  Sleep 500
!macroend
