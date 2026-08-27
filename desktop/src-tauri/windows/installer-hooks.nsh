; The installer-time server option — the third leg of the install story:
; offered here, still installable later from the app if declined, and the
; client fully usable against any instance either way, by design.
;
; NSIS can ask a question but can't reach into the app, so the answer is a
; file: `host-setup.requested` beside the executable. The app reads it on
; first launch, opens the server setup, and leaves a tombstone so the
; question never reopens (see host_setup_requested in main.rs).
!macro NSIS_HOOK_POSTINSTALL
  MessageBox MB_YESNO|MB_ICONQUESTION \
    "SOVRGNnet can also run a full server on this computer — chat, files, and voice for you and your friends, hosted by you.$\r$\n$\r$\nSet it up when the app first opens?$\r$\n$\r$\n(You can always do this later from inside the app.)" \
    IDYES hostyes IDNO hostdone
hostyes:
  FileOpen $0 "$INSTDIR\host-setup.requested" w
  FileClose $0
hostdone:
!macroend
