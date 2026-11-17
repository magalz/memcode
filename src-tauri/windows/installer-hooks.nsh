; Verify the installed payload after extraction and shell registration. A
; removed/blocked executable must not lead to a misleading Finish/Launch page.
!macro NSIS_HOOK_POSTINSTALL
  IfFileExists "$INSTDIR\memcode.exe" +2 0
    Goto memcode_missing_install_file
  IfFileExists "$INSTDIR\desktop-runtime\node.exe" +2 0
    Goto memcode_missing_install_file
  IfFileExists "$INSTDIR\runtime\service.cjs" +2 0
    Goto memcode_missing_install_file
  IfFileExists "$INSTDIR\memtrace-engine\engine.zip" +2 0
    Goto memcode_missing_install_file
  IfFileExists "$INSTDIR\uninstall.exe" memcode_install_verified 0
  memcode_missing_install_file:
    SetErrorLevel 2
    DetailPrint "MemCode installation is incomplete: a required program file is missing."
    IfSilent +2 0
      MessageBox MB_OK|MB_ICONSTOP "MemCode could not finish installation because a required program file is missing.$\r$\n$\r$\nCheck Windows Security > Protection history for a blocked or removed MemCode file, then run this installer again.$\r$\n$\r$\nInstallation folder: $INSTDIR$\r$\nYour projects and settings are kept separately."
    Abort "MemCode installation is incomplete. Run the installer again to repair it."
  memcode_install_verified:
!macroend
