!include nsDialogs.nsh
!include FileFunc.nsh
!include "${BUILD_RESOURCES_DIR}\install-directory.nsh"

!ifndef FCODE_INSTALLER_DEFAULT_LOG_PATH
  !define FCODE_INSTALLER_DEFAULT_LOG_PATH "$TEMP\FCode-installer.log"
!endif
!ifndef FCODE_INSTALLER_ELEVATED_LOG_PATH
  !define FCODE_INSTALLER_ELEVATED_LOG_PATH "$WINDIR\Logs\FCode-installer.log"
!endif
!ifndef FCODE_INSTALLER_IS_ELEVATED_INNER
  ; 来源只在测试夹具模拟内层，正式默认恒假会让提权进程继续使用调用方 /LOG。
  ; 使用 electron-builder 同一 UAC 判据；隔离夹具仍可显式替换，不改变真正的提权流程。
  !include UAC.nsh
  !define FCODE_INSTALLER_IS_ELEVATED_INNER `${UAC_IsInnerInstance}`
!endif

!ifndef FCODE_INSTALL_MANIFEST_NAME
  !define FCODE_INSTALL_MANIFEST_NAME ".koincode-install-manifest"
!endif

!ifndef FCODE_UNINSTALLER_LOG_PATH
  !define FCODE_UNINSTALLER_LOG_PATH "$TEMP\FCode-uninstaller.log"
!endif
!ifndef FCODE_UNINSTALLER_FUNCTION_PREFIX
  !define FCODE_UNINSTALLER_FUNCTION_PREFIX "un."
!endif

!ifdef BUILD_UNINSTALLER
  Var FCodeUninstallerLogUnavailable

  ; 卸载器只在更新时删除旧文件；单独记录清理阶段，避免外层把权限/空间错误误报成应用仍在运行。
  !macro FCodeReportUninstallerStage MESSAGE
    DetailPrint "FCode: ${MESSAGE}"
    Push "${MESSAGE}"
    Call ${FCODE_UNINSTALLER_FUNCTION_PREFIX}FCodeWriteUninstallerLog
  !macroend

  Function ${FCODE_UNINSTALLER_FUNCTION_PREFIX}FCodeWriteUninstallerLog
    Exch $R9
    Push $R0
    Push $R1
    Push $R2

    StrCmp $FCodeUninstallerLogUnavailable "1" fcodeUninstallerLogDone
    ClearErrors
    FileOpen $R1 "${FCODE_UNINSTALLER_LOG_PATH}" a
    IfErrors fcodeUninstallerLogFailed fcodeUninstallerLogWrite
    fcodeUninstallerLogWrite:
      System::Call "kernel32::GetCurrentProcessId() i.R0"
      FileSeek $R1 0 END
      FileWrite $R1 "[pid=$R0] $R9$\r$\n"
      FileClose $R1
      Goto fcodeUninstallerLogDone
    fcodeUninstallerLogFailed:
      ; 日志不可写不应改变卸载结果，保留原始清理错误供外层处理。
      StrCpy $FCodeUninstallerLogUnavailable "1"
      ClearErrors
    fcodeUninstallerLogDone:
      Pop $R2
      Pop $R1
      Pop $R0
      Pop $R9
  FunctionEnd

  !macro customRemoveFilesDiagnosticsStart
    !insertmacro FCodeReportUninstallerStage "cleanup-started"
  !macroend

  !macro customRemoveFilesDiagnosticsComplete
    !insertmacro FCodeReportUninstallerStage "cleanup-completed"
  !macroend
!endif

!macro customRemoveFiles
  ; electron-builder 默认在更新时递归删除整个 $INSTDIR，用户放入的无关文件也会被清掉。
  ; 只按上一版本随包生成的所有权清单删除，清单缺失时迁移旧版本采用 fail-open 保留策略。
  ${if} ${isUpdated}
    !ifdef BUILD_UNINSTALLER
      !insertmacro customRemoveFilesDiagnosticsStart
    !endif
    ClearErrors
    FileOpen $R0 "$INSTDIR\${FCODE_INSTALL_MANIFEST_NAME}" r
    IfErrors fcodeManifestMissing

    fcodeManifestRead:
      ClearErrors
      FileRead $R0 $R1
      IfErrors fcodeManifestClose
      ; NSIS FileRead 保留行尾 CRLF；打包清单统一使用换行结尾，先去掉两个行尾字符。
      StrCpy $R1 $R1 -2
      StrCmp $R1 "" fcodeManifestRead
      ; Never delete the ownership list while its read handle is still open.
      StrCmp $R1 "${FCODE_INSTALL_MANIFEST_NAME}" fcodeManifestRead

      ; 拒绝绝对路径和 .. 前缀，避免损坏或篡改清单越界删除。
      StrCpy $R2 $R1 1
      StrCmp $R2 "\\" fcodeManifestRead
      StrCmp $R2 "/" fcodeManifestRead
      StrCpy $R2 $R1 2
      StrCmp $R2 ".." fcodeManifestRead
      StrCmp $R1 "${UNINSTALL_FILENAME}" fcodeManifestRead
      GetFullPathName $R2 "$INSTDIR\$R1"
      StrCmp $R2 "$INSTDIR\$R1" 0 fcodeManifestRead

      ; 当前版本卸载器与外层安装器是两个进程；逐项记录到卸载器日志，便于核对真正尝试删除的文件。
      !ifdef BUILD_UNINSTALLER
        !insertmacro FCodeReportUninstallerStage "cleanup-file path=$R1"
      !endif
      ClearErrors
      Delete "$INSTDIR\$R1"
      IfErrors fcodeManifestDeleteFailed
      Goto fcodeManifestRead

    fcodeManifestDeleteFailed:
      StrCmp $R0 "" +2
        FileClose $R0
      !ifdef BUILD_UNINSTALLER
        !insertmacro FCodeReportUninstallerStage "cleanup-failed reason=permission-or-disk-space"
      !endif
      Abort "Unable to delete previous installation file: $INSTDIR\$R1"

    fcodeManifestClose:
      FileClose $R0
      StrCpy $R0 ""
      StrCpy $R1 "${FCODE_INSTALL_MANIFEST_NAME}"
      !ifdef BUILD_UNINSTALLER
        !insertmacro FCodeReportUninstallerStage "cleanup-file path=$R1"
      !endif
      ClearErrors
      Delete "$INSTDIR\${FCODE_INSTALL_MANIFEST_NAME}"
      IfErrors fcodeManifestDeleteFailed
      Goto fcodeManifestDone

    fcodeManifestMissing:
      ; 首次从旧版本升级时没有清单，不能猜测所有权并删除用户文件。
      !ifdef BUILD_UNINSTALLER
        !insertmacro FCodeReportUninstallerStage "cleanup-skipped reason=manifest-missing action=preserve"
      !endif
      ClearErrors

    fcodeManifestDone:
      !ifdef BUILD_UNINSTALLER
        !insertmacro customRemoveFilesDiagnosticsComplete
      !endif
  ${else}
    ; 普通卸载仍保持 electron-builder 的全量删除语义；ownership 清单只约束覆盖更新。
    SetOutPath $TEMP
    RMDir /r $INSTDIR
  ${endIf}
!macroend

!ifndef BUILD_UNINSTALLER
  Var FCodeInstallerLogPath
  Var FCodeInstallerLogUnavailable
  Var FCodeInstallerProcessRole
  Var FCodeUninstallerDetailsUnavailable
  Var FCodePreviousUninstallerSupportsManifest

  ; 详情面板和文件日志共用同一条阶段事件，避免静默安装丢失关键上下文。
  !macro FCodeReportInstallerStage MESSAGE
    SetDetailsPrint listonly
    DetailPrint "FCode: ${MESSAGE}"
    Push "${MESSAGE}"
    Call FCodeWriteInstallerLog
  !macroend

  Function FCodeWriteInstallerLog
    Exch $R9
    Push $R0
    Push $R1
    Push $R2

    StrCmp $FCodeInstallerLogPath "" fcodeInstallerLogDone
    StrCmp $FCodeInstallerLogUnavailable "1" fcodeInstallerLogDone
    StrCpy $R2 0
    fcodeInstallerLogOpen:
      ClearErrors
      FileOpen $R1 $FCodeInstallerLogPath a
      IfErrors fcodeInstallerLogRetry fcodeInstallerLogWrite
    fcodeInstallerLogRetry:
      IntOp $R2 $R2 + 1
      IntCmp $R2 3 fcodeInstallerLogFailed fcodeInstallerLogWait fcodeInstallerLogFailed
    fcodeInstallerLogWait:
      Sleep 50
      Goto fcodeInstallerLogOpen
    fcodeInstallerLogWrite:
      System::Call "kernel32::GetCurrentProcessId() i.R0"
      FileSeek $R1 0 END
      FileWrite $R1 "[pid=$R0] $R9$\r$\n"
      FileClose $R1
      Goto fcodeInstallerLogDone
    fcodeInstallerLogFailed:
      StrCpy $FCodeInstallerLogUnavailable "1"
      ClearErrors
    fcodeInstallerLogDone:
      Pop $R2
      Pop $R1
      Pop $R0
      Pop $R9
  FunctionEnd

  !include "${BUILD_RESOURCES_DIR}\install-manifest.nsh"

  Function FCodeResetUninstallerLog
    StrCpy $FCodeUninstallerDetailsUnavailable ""
    ClearErrors
    FileOpen $R0 "${FCODE_UNINSTALLER_LOG_PATH}" w
    IfErrors fcodeUninstallerDetailsResetFailed fcodeUninstallerDetailsResetSucceeded
    fcodeUninstallerDetailsResetSucceeded:
      FileClose $R0
      Goto fcodeUninstallerDetailsResetDone
    fcodeUninstallerDetailsResetFailed:
      ; 外层详情不能读取旧卸载器日志时仍继续安装，文件日志和退出码仍是最终依据。
      StrCpy $FCodeUninstallerDetailsUnavailable "1"
      ClearErrors
    fcodeUninstallerDetailsResetDone:
  FunctionEnd

  Function FCodeShowUninstallerCleanupDetails
    Push $R0
    Push $R1
    Push $R2

    StrCmp $FCodeUninstallerDetailsUnavailable "1" fcodeShowUninstallerDetailsDone
    ClearErrors
    FileOpen $R0 "${FCODE_UNINSTALLER_LOG_PATH}" r
    IfErrors fcodeShowUninstallerDetailsDone
    fcodeShowUninstallerDetailsRead:
      ClearErrors
      FileRead $R0 $R1
      IfErrors fcodeShowUninstallerDetailsClose
      StrCmp $R1 "" fcodeShowUninstallerDetailsRead
      SetDetailsPrint listonly
      DetailPrint "FCode: cleanup-log $R1"
      Goto fcodeShowUninstallerDetailsRead
    fcodeShowUninstallerDetailsClose:
      FileClose $R0
    fcodeShowUninstallerDetailsDone:
      Pop $R2
      Pop $R1
      Pop $R0
  FunctionEnd

  !macro preInit
    Call FCodeInitializeInstallerLog
  !macroend

  !macro customInit
    IfSilent fcodeInstallerInitSilent fcodeInstallerInitInteractive
    fcodeInstallerInitSilent:
      !insertmacro FCodeReportInstallerStage "installer-initialized mode=silent"
      Goto fcodeInstallerInitDone
    fcodeInstallerInitInteractive:
      !insertmacro FCodeReportInstallerStage "installer-initialized mode=interactive"
    fcodeInstallerInitDone:
  !macroend

  ; 这些宏由打包时的 electron-builder installSection.nsh 补丁按安装顺序调用。
  ; 只有阶段 marker 写入详情和日志，解压文件明细由 NSIS 的 File 命令在 listonly 模式输出。
  !macro customInstallSectionStarted
    !insertmacro FCodeReportInstallerStage "install-started"
  !macroend

  !macro customInstallCleanupStarted
    Call FCodeResetUninstallerLog
    !insertmacro FCodeReportInstallerStage "cleanup-started"
  !macroend

  !macro customInstallCleanupCompleted
    !insertmacro FCodeReportInstallerStage "cleanup-completed"
    Call FCodeShowUninstallerCleanupDetails
  !macroend

  !macro customInstallExtractStarted
    !insertmacro FCodeReportInstallerStage "extract-started"
  !macroend

  !macro customInstallExtractCompleted
    !insertmacro FCodeReportInstallerStage "extract-completed"
  !macroend

  !macro customInstallShortcutsStarted
    !insertmacro FCodeReportInstallerStage "shortcuts-started"
  !macroend

  !macro customInstallShortcutsCompleted
    !insertmacro FCodeReportInstallerStage "shortcuts-completed"
  !macroend

  Function FCodeDetectPreviousUninstallerCapabilities
    StrCpy $FCodePreviousUninstallerSupportsManifest "0"
    ; manifest 是卸载器能力标记：存在即表示旧卸载器会按清单选择性删除。
    IfFileExists "$INSTDIR\${FCODE_INSTALL_MANIFEST_NAME}" 0 fcodePreviousUninstallerCapabilityCheckNested
      StrCpy $FCodePreviousUninstallerSupportsManifest "1"
      Return

    fcodePreviousUninstallerCapabilityCheckNested:
      ; assisted installer 的目录页会在后续 instfilesPre 才补上 APP_FILENAME 子目录，提前兼容两种形态。
      IfFileExists "$INSTDIR\${APP_FILENAME}\${FCODE_INSTALL_MANIFEST_NAME}" 0 fcodePreviousUninstallerCapabilityDone
        StrCpy $FCodePreviousUninstallerSupportsManifest "1"

    fcodePreviousUninstallerCapabilityDone:
  FunctionEnd

  !macro customUnInstallCheck
    ; handleUninstallResult 会把旧卸载器的退出码放在 $R0；失败时显示清理诊断，
    ; 不再复用 appCannotBeClosed（该文案只适用于进程占用）。
    ${if} $R0 != 0
      ; 静默自动更新无人值守，未设置 /SD 的模态框会一直等待用户点击，
      ; 使明确的退出码无法返回 electron-updater。静默时自动采用 IDOK，交互时仍显示提示。
      SetDetailsPrint listonly
      DetailPrint "FCode: cleanup-failed exit-code=$R0"
      Call FCodeShowUninstallerCleanupDetails
      MessageBox MB_OK|MB_ICONSTOP "旧版本清理失败（错误码 $R0）。可能是文件被占用、权限不足或磁盘空间不足。详细日志：${FCODE_UNINSTALLER_LOG_PATH}" /SD IDOK
      SetErrorLevel 2
      Quit
    ${endif}
  !macroend

  !macro customUnInstallCheckCurrentUser
    ; per-machine 安装切换到 HKCU 旧版本时，electron-builder 会走另一条 hook；
    ; 复用同一诊断，避免同一个清理失败因注册表根键不同又退回默认文案。
    !insertmacro customUnInstallCheck
  !macroend
!endif

!define FCODE_INSTALL_DIR_BACK_BUTTON_WIDTH 180

!macro customHeader
  !ifndef BUILD_UNINSTALLER
    ; 异步生成的 header 可能先 include 本文件，再注册 UAC 插件目录。
    ; 在 customHeader 展开函数，确保插件已注册；preInit 仍调用同一函数和真实 UAC 判据。
    Function FCodeInitializeInstallerLog
      Push $R0
      Push $R1
      Push $R2
      StrCpy $FCodeInstallerLogUnavailable ""
      ${If} ${FCODE_INSTALLER_IS_ELEVATED_INNER}
        StrCpy $FCodeInstallerProcessRole "elevated-inner"
        StrCpy $FCodeInstallerLogPath "${FCODE_INSTALLER_ELEVATED_LOG_PATH}"
      ${Else}
        StrCpy $FCodeInstallerProcessRole "outer"
        StrCpy $R0 $CMDLINE
        ClearErrors
        ${GetOptions} $R0 "/LOG=" $R1
        IfErrors fcodeInstallerLogUseDefault
        StrCmp $R1 "" fcodeInstallerLogUseDefault
        StrCpy $FCodeInstallerLogPath $R1
        Goto fcodeInstallerLogPathReady
        fcodeInstallerLogUseDefault:
          StrCpy $FCodeInstallerLogPath "${FCODE_INSTALLER_DEFAULT_LOG_PATH}"
        fcodeInstallerLogPathReady:
          ${GetParent} $FCodeInstallerLogPath $R2
          StrCmp $R2 "" fcodeInstallerLogInitialized
          CreateDirectory "$R2"
      ${EndIf}
      fcodeInstallerLogInitialized:
        !insertmacro FCodeReportInstallerStage "installer-process-started role=$FCodeInstallerProcessRole"
      Pop $R2
      Pop $R1
      Pop $R0
    FunctionEnd

    ; electron-builder 的 common.nsh 先设置 ShowInstDetails nevershow；
    ; hide 在该模板组合下仍可能留下空白列表且没有可展开入口，因此直接常显阶段详情。
    ShowInstDetails show
    !ifdef allowToChangeInstallationDirectory
      ; electron-builder 已在 assistedInstaller.nsh 中用该开关生成安装目录页面，
      ; 但 installUtil.nsh 随后还会用它禁止无 --updated 的手动覆盖保留快捷方式，导致旧卸载器
      ; 调用 UninstShortcut 注销开始菜单固定项。页面生成后撤掉开关，让自动更新和手动覆盖
      ; 在同一安装目录覆盖时都通过 KeepShortcuts 保留同一个 .lnk。
      !undef allowToChangeInstallationDirectory
    !endif
  !endif
!macroend

!ifndef BUILD_UNINSTALLER
  ; electron-builder 会先编译卸载器，但快捷方式目标读取只在安装更新流程中调用。
  ; 若把函数带入卸载器，NSIS 会产生 6010 未引用告警，并在 /WX 下直接中断 Windows CI。
  Function FCodeReadShortcutTarget
    Exch $R9
    Push $R1
    Push $R2

    StrCpy $R2 ""
    System::Call 'Kernel32::SetEnvironmentVariableW(w "FCODE_SHORTCUT_PATH", w "$R9") i.R1'
    StrCmp $R1 "0" fcodeReadShortcutTargetDone 0

    nsExec::ExecToStack /TIMEOUT=5000 `"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -Command "[Console]::Out.Write(([Activator]::CreateInstance([type]::GetTypeFromProgID('WScript.Shell'))).CreateShortcut([Environment]::GetEnvironmentVariable('FCODE_SHORTCUT_PATH')).TargetPath)"`
    Pop $R1
    Pop $R2
    StrCmp $R1 "0" fcodeReadShortcutTargetDone 0
    StrCpy $R2 ""

    fcodeReadShortcutTargetDone:
      System::Call 'Kernel32::SetEnvironmentVariableW(w "FCODE_SHORTCUT_PATH", p 0) i.R1'
      StrCpy $R9 "$R2"
      Pop $R2
      Pop $R1
      Exch $R9
  FunctionEnd
!endif

!macro FCodeRepairShortcutIfNeeded SHORTCUT_PATH LABEL_PREFIX
  ${if} ${FileExists} "${SHORTCUT_PATH}"
    Push "${SHORTCUT_PATH}"
    Call FCodeReadShortcutTarget
    Pop $R0
    StrCmp $R0 "$appExe" ${LABEL_PREFIX}Done 0

    ; 历史版本可能留下指向已移动 exe 的 .lnk，但无条件覆盖正确快捷方式会让
    ; 部分 Windows 11 丢失“所有应用”索引或用户固定关系，因此只修复目标不一致的项。
    ClearErrors
    CreateShortCut "${SHORTCUT_PATH}" "$appExe" "" "$appExe" 0 "" "" "${APP_DESCRIPTION}"
    IfErrors ${LABEL_PREFIX}Failed ${LABEL_PREFIX}Succeeded
    ${LABEL_PREFIX}Failed:
      DetailPrint "Unable to repair shortcut: ${SHORTCUT_PATH}"
      ClearErrors
      Goto ${LABEL_PREFIX}Done
    ${LABEL_PREFIX}Succeeded:
      WinShell::SetLnkAUMI "${SHORTCUT_PATH}" "${APP_ID}"
      ; 重写后的 .lnk 必须在最后一次写入后通知 Shell，避免开始菜单继续使用旧索引。
      System::Call 'Shell32::SHChangeNotify(i 0x00002000, i 0x0005, w "${SHORTCUT_PATH}", p 0)'
    ${LABEL_PREFIX}Done:
  ${endIf}
!macroend

!macro customInstall
  !ifndef BUILD_UNINSTALLER
    !insertmacro FCodeReportInstallerStage "install-finalization-started"
  !endif
  ${if} ${isUpdated}
  ${orIf} $keepShortcuts == "true"
    !ifndef DO_NOT_CREATE_START_MENU_SHORTCUT
      !insertmacro FCodeRepairShortcutIfNeeded "$newStartMenuLink" fcodeStartMenuShortcutRepair
    !endif

    !ifndef DO_NOT_CREATE_DESKTOP_SHORTCUT
      !insertmacro FCodeRepairShortcutIfNeeded "$newDesktopLink" fcodeDesktopShortcutRepair
    !endif
  ${endIf}

  ; 手动覆盖没有 --updated，继承旧快捷方式时仍需检查目标；首次安装没有旧项，
  ; 不应额外启动 PowerShell。用户已删除的快捷方式也不会重建。
  ; assisted installer 完成页始终直接运行本次安装落盘的 exe。
  StrCpy $launchLink "$appExe"
  !ifndef BUILD_UNINSTALLER
    !insertmacro FCodeReportInstallerStage "install-completed"
  !endif
!macroend

!macro customPageAfterChangeDir
  Function FCodeResizeInstallDirBackButton
    GetDlgItem $1 $HWNDPARENT 3
    StrCmp $1 0 fcodeResizeInstallDirBackButtonDone 0

    System::Call "*(i 0, i 0, i 0, i 0) p.r2"
    StrCmp $2 0 fcodeResizeInstallDirBackButtonDone 0
    System::Call "user32::GetWindowRect(p r1, p r2)"
    System::Call "user32::MapWindowPoints(p 0, p $HWNDPARENT, p r2, i 2)"
    System::Call "*$2(i.r3,i.r4,i.r5,i.r6)"
    System::Free $2

    IntOp $7 $5 - $3
    IntOp $8 $6 - $4
    IntCmp $7 ${FCODE_INSTALL_DIR_BACK_BUTTON_WIDTH} fcodeResizeInstallDirBackButtonDone fcodeResizeInstallDirBackButtonResize fcodeResizeInstallDirBackButtonDone

    fcodeResizeInstallDirBackButtonResize:
      ; 阻断页把“上一步”改成中文动作文案，NSIS 默认按钮宽度可能裁掉文字。
      ; 保持右边缘不动向左扩宽，避免和右侧“安装/取消”按钮重叠。
      IntOp $3 $5 - ${FCODE_INSTALL_DIR_BACK_BUTTON_WIDTH}
      System::Call "user32::MoveWindow(p r1, i r3, i r4, i ${FCODE_INSTALL_DIR_BACK_BUTTON_WIDTH}, i r8, i 1)"

    fcodeResizeInstallDirBackButtonDone:
  FunctionEnd

  Function FCodeFindNestedDataDir
    Exch $R9
    Push $0
    Push $1

    StrCpy $R2 ""

    IfFileExists "$R9\.koincode\*.*" 0 +2
      StrCpy $R2 "$R9\.koincode"
    StrCmp $R2 "" 0 fcodeFindNestedDataDirDone
    IfFileExists "$R9\.koincode" 0 fcodeFindNestedDataDirListChildren
      StrCpy $R2 "$R9\.koincode"
    StrCmp $R2 "" 0 fcodeFindNestedDataDirDone

    fcodeFindNestedDataDirListChildren:
      ; Detect old product data only to prevent destructive installation into its directory.
      IfFileExists "$R9\.fcode\*.*" 0 +2
        StrCpy $R2 "$R9\.fcode"
      StrCmp $R2 "" 0 fcodeFindNestedDataDirDone
      IfFileExists "$R9\.fcode" 0 +2
        StrCpy $R2 "$R9\.fcode"
      StrCmp $R2 "" 0 fcodeFindNestedDataDirDone
      ; 兼容历史数据根，改名不能绕过安装目录的数据丢失保护。
      IfFileExists "$R9\.zcode\*.*" 0 +2
        StrCpy $R2 "$R9\.zcode"
      StrCmp $R2 "" 0 fcodeFindNestedDataDirDone
      IfFileExists "$R9\.zcode" 0 +2
        StrCpy $R2 "$R9\.zcode"
      StrCmp $R2 "" 0 fcodeFindNestedDataDirDone
      FindFirst $0 $1 "$R9\*"
      IfErrors fcodeFindNestedDataDirDone

    fcodeFindNestedDataDirNext:
      StrCmp $1 "" fcodeFindNestedDataDirClose
      StrCmp $1 "." fcodeFindNestedDataDirContinue
      StrCmp $1 ".." fcodeFindNestedDataDirContinue
      IfFileExists "$R9\$1\*.*" 0 fcodeFindNestedDataDirContinue
        Push "$R9\$1"
        Call FCodeFindNestedDataDir
        StrCmp $R2 "" fcodeFindNestedDataDirContinue fcodeFindNestedDataDirClose

    fcodeFindNestedDataDirContinue:
      FindNext $0 $1
      IfErrors fcodeFindNestedDataDirClose
      Goto fcodeFindNestedDataDirNext

    fcodeFindNestedDataDirClose:
      FindClose $0

    fcodeFindNestedDataDirDone:
      Pop $1
      Pop $0
      Pop $R9
  FunctionEnd

  Function FCodeBlockInstallDirContainsData
    Call FCodeDetectPreviousUninstallerCapabilities
    StrCmp $FCodePreviousUninstallerSupportsManifest "1" fcodeInstallDirDataBlockSkip

    ;  用户可能把数据存储目录放进安装目录，Windows 更新覆盖安装目录时会清掉 .fcode。
    ; assisted installer 会把不含应用名的选择目录补成 "$INSTDIR\${APP_FILENAME}"，所以这里按相同规则计算最终安装目录。
    ${StrContains} $R1 "${APP_FILENAME}" "$INSTDIR"
    StrCmp $R1 "" 0 fcodeInstallDirDataBlockUseSelectedDir
    StrCpy $R0 "$INSTDIR\${APP_FILENAME}"
    Goto fcodeInstallDirDataBlockCheckDir

    fcodeInstallDirDataBlockUseSelectedDir:
      StrCpy $R0 "$INSTDIR"

    fcodeInstallDirDataBlockCheckDir:
      ; Block installation when product data exists anywhere under the selected installation directory.
      ; The installer manages the whole tree; any nested .koincode directory must block replacement.
      Push "$R0"
      Call FCodeFindNestedDataDir
      StrCmp $R2 "" fcodeInstallDirDataBlockSkip fcodeInstallDirDataBlockFound

    fcodeInstallDirDataBlockFound:
      IfSilent fcodeInstallDirDataBlockSilent

      !insertmacro MUI_HEADER_TEXT "需要修改安装目录" "当前安装目录或其子目录包含 FCode 数据目录"
      nsDialogs::Create 1018
      Pop $0
      StrCmp $0 error fcodeInstallDirDataBlockDialogFailed 0

      ${NSD_CreateLabel} 0u 0u 300u 44u "The selected installation directory contains KoinCode data:$\r$\n$R2"
      Pop $1
      ${NSD_CreateLabel} 0u 54u 300u 70u "为避免历史会话和配置被安装器清理，请返回上一步选择其他安装目录。$\r$\n$\r$\n当前目录不能继续安装。"
      Pop $1

      GetDlgItem $1 $HWNDPARENT 1
      EnableWindow $1 0
      GetDlgItem $1 $HWNDPARENT 3
      EnableWindow $1 1
      SendMessage $1 ${WM_SETTEXT} 0 "STR:重选目录"
      Call FCodeResizeInstallDirBackButton

      nsDialogs::Show
      Return

    fcodeInstallDirDataBlockDialogFailed:
      MessageBox MB_OK|MB_ICONSTOP "Installation stopped because the selected directory contains KoinCode data. Restart the installer and choose a different directory."
      SetErrorLevel 1
      Quit

    fcodeInstallDirDataBlockSilent:
      SetErrorLevel 1
      Quit

    fcodeInstallDirDataBlockSkip:
      Abort
  FunctionEnd

  Function FCodeBlockInstallDirContainsDataLeave
    ; 阻断页的下一步按钮已禁用，但自动化或系统快捷键仍可能触发下一页。
    ; leave 回调只处理继续前进的路径，这里强制留在当前页，确保用户只能返回修改安装目录。
    Abort
  FunctionEnd

  Page custom FCodeBlockInstallDirContainsData FCodeBlockInstallDirContainsDataLeave
!macroend
