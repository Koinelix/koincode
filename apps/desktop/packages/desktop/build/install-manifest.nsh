; Repair only the exact self-entry emitted first by the historical sorted generator.
; Copy the remainder as bytes, then atomically replace the file after closing all handles.
Function FCodeNormalizePreviousManifest
  Exch $R9
  Push $R0
  Push $R1
  Push $R2
  Push $R3
  Push $R4
  Push $R5
  Push $R6
  Push $R7
  Push $R8
  StrCpy $R0 ""
  StrCpy $R1 ""
  StrCpy $R2 ""
  StrCpy $R3 0
  StrCpy $R8 "open"

  IfFileExists "$R9\${FCODE_INSTALL_MANIFEST_NAME}" 0 fcodeNormalizeManifestDone
  ClearErrors
  FileOpen $R0 "$R9\${FCODE_INSTALL_MANIFEST_NAME}" r
  IfErrors fcodeNormalizeManifestFailed
  FileRead $R0 $R7
  StrCmp $R7 "${FCODE_INSTALL_MANIFEST_NAME}$\r$\n" 0 fcodeNormalizeManifestCloseUnchanged

  StrCpy $R8 "create-temporary-file"
  ClearErrors
  GetTempFileName $R2 "$R9"
  IfErrors fcodeNormalizeManifestFailed
  FileOpen $R1 "$R2" w
  IfErrors fcodeNormalizeManifestFailed
  System::Alloc 65536
  Pop $R3
  StrCmp $R3 0 fcodeNormalizeManifestFailed
  StrCpy $R8 "copy"

  fcodeNormalizeManifestCopy:
    System::Call 'kernel32::ReadFile(p $R0, p $R3, i 65536, *i .R4, p 0) i.R6'
    StrCmp $R6 0 fcodeNormalizeManifestFailed
    StrCmp $R4 0 fcodeNormalizeManifestReplace
    System::Call 'kernel32::WriteFile(p $R1, p $R3, i $R4, *i .R5, p 0) i.R6'
    StrCmp $R6 0 fcodeNormalizeManifestFailed
    StrCmp $R4 $R5 0 fcodeNormalizeManifestFailed
    Goto fcodeNormalizeManifestCopy

  fcodeNormalizeManifestReplace:
    System::Call 'kernel32::FlushFileBuffers(p $R1) i.R6'
    StrCmp $R6 0 fcodeNormalizeManifestFailed
    FileClose $R0
    FileClose $R1
    StrCpy $R0 ""
    StrCpy $R1 ""
    System::Free $R3
    StrCpy $R3 0
    StrCpy $R8 "replace"
    System::Call 'kernel32::ReplaceFileW(w "$R9\${FCODE_INSTALL_MANIFEST_NAME}", w "$R2", p 0, i 0, p 0, p 0) i.R6'
    StrCmp $R6 0 fcodeNormalizeManifestFailed
    !insertmacro FCodeReportInstallerStage "previous-manifest-normalized action=remove-self-entry"
    Goto fcodeNormalizeManifestDone

  fcodeNormalizeManifestCloseUnchanged:
    FileClose $R0
    Goto fcodeNormalizeManifestDone

  fcodeNormalizeManifestFailed:
    StrCmp $R0 "" +2
      FileClose $R0
    StrCmp $R1 "" +2
      FileClose $R1
    StrCmp $R3 0 +2
      System::Free $R3
    StrCmp $R2 "" +2
      Delete "$R2"
    !insertmacro FCodeReportInstallerStage "cleanup-failed reason=manifest-normalization stage=$R8"
    MessageBox MB_OK|MB_ICONSTOP "Unable to prepare the previous installation file list. Close applications using the installation folder and retry. Installer log: $FCodeInstallerLogPath" /SD IDOK
    SetErrorLevel 2
    Quit

  fcodeNormalizeManifestDone:
    ClearErrors
    Pop $R8
    Pop $R7
    Pop $R6
    Pop $R5
    Pop $R4
    Pop $R3
    Pop $R2
    Pop $R1
    Pop $R0
    Pop $R9
FunctionEnd

!macro customPreparePreviousUninstaller
  Push "$installationDir"
  Call FCodeNormalizePreviousManifest
!macroend
