; Windows installer hooks.
;
; Two jobs: stop what is running before replacing it, and offer the server
; option on the way out.

; ---------------------------------------------------------------- preinstall
;
; Stop the server components before overwriting them.
;
; Tauri's own template already notices the *app* is running and asks the person
; to close it. That is not enough here, and the gap produced a failed upgrade
; on a real machine:
;
;   Error opening file for writing:
;   C:\Users\...\AppData\Local\SOVRGNnet\host\cloudflared.exe
;
; A desktop host spawns cloudflared, dendrite, node, kubo, livekit and postgres
; *from the install directory* — bundled resources, by design. Closing the app
; does not close them: the supervisor tears them down on a graceful exit, and a
; process the installer killed never gets one, so the children are orphaned and
; keep their files locked. Extraction then dies partway through, on whichever
; binary it reached first, having already replaced some of the others.
;
; So: kill anything running out of $INSTDIR, and only out of $INSTDIR. By path,
; never by name — `taskkill /IM node.exe` on a developer's machine would take
; their editor's language server, their dev server, and anything else they had
; open, and `postgres.exe` would take their actual database. The one thing that
; identifies these processes as ours is where they were loaded from.
;
; StartsWith rather than -like, because a path is a literal: a username
; containing `[` would make a wildcard match quietly stop matching.
;
; The command is a backtick-quoted NSIS string. That is NSIS's third quote
; character, and it is the only one that leaves both `'` and `"` usable
; inside — which this needs, since PowerShell wants double quotes around
; -Command and single quotes around the path. `$$` is a literal `$`, so
; `$$_` reaches PowerShell as `$_` rather than being read as an NSIS
; variable.
;
; Known limitation: an install path containing an apostrophe — a Windows
; user called O'Brien — breaks PowerShell's single-quoted string, the
; command does nothing, and the upgrade fails exactly the way it did
; before this hook existed. Not silently wrong, just not helped; escaping
; it properly needs the path passed as an argument rather than embedded,
; which is more machinery than the case deserves until someone hits it.
!macro NSIS_HOOK_PREINSTALL
  DetailPrint "Stopping any SOVRGNnet server components still running..."
  nsExec::ExecToLog `powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "Get-CimInstance Win32_Process | Where-Object { $$_.ExecutablePath -and $$_.ExecutablePath.StartsWith('$INSTDIR') } | ForEach-Object { Stop-Process -Id $$_.ProcessId -Force -ErrorAction SilentlyContinue }"`
  Pop $0
  ; Windows releases file handles a moment after the process goes. Without
  ; this the extraction can still meet a lock it is about to stop meeting,
  ; which is the most annoying kind of intermittent failure.
  Sleep 1500
  ; Again, for anything that was mid-spawn when the first pass ran — postgres
  ; in particular starts helpers of its own.
  nsExec::ExecToLog `powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "Get-CimInstance Win32_Process | Where-Object { $$_.ExecutablePath -and $$_.ExecutablePath.StartsWith('$INSTDIR') } | ForEach-Object { Stop-Process -Id $$_.ProcessId -Force -ErrorAction SilentlyContinue }"`
  Pop $0
  Sleep 500
!macroend

; -------------------------------------------------------------- preuninstall
;
; Same reasoning, same one-line difference between a clean uninstall and a
; folder that cannot be removed: an uninstall that leaves the server running
; leaves a database and a tunnel alive with nothing left to manage them.
!macro NSIS_HOOK_PREUNINSTALL
  DetailPrint "Stopping any SOVRGNnet server components still running..."
  nsExec::ExecToLog `powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "Get-CimInstance Win32_Process | Where-Object { $$_.ExecutablePath -and $$_.ExecutablePath.StartsWith('$INSTDIR') } | ForEach-Object { Stop-Process -Id $$_.ProcessId -Force -ErrorAction SilentlyContinue }"`
  Pop $0
  Sleep 1500
!macroend

; --------------------------------------------------------------- postinstall
;
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
