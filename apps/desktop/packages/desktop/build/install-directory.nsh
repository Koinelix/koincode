!include FileFunc.nsh
!include LogicLib.nsh

!ifndef BUILD_UNINSTALLER
  !macro FCodeNormalizeLegacyInstallDirectory
    !if "${APP_FILENAME}" == "FCode"
      ; 旧升级 GUID 会读回 ZCode；上游目录页还会把它补成 ZCode\FCode。
      ; 只调整安装目标，旧注册表位置仍用于卸载，且随后 /D 可覆盖这里的默认值。
      Push $R0
      Push $R1
      ${GetFileName} "$INSTDIR" $R0
      ${If} $R0 == "ZCode"
        ${GetParent} "$INSTDIR" $R1
        StrCpy $INSTDIR "$R1\${APP_FILENAME}"
      ${ElseIf} $R0 == "${APP_FILENAME}"
        ${GetParent} "$INSTDIR" $R1
        ${GetFileName} "$R1" $R0
        ${If} $R0 == "ZCode"
          ${GetParent} "$R1" $R0
          StrCpy $INSTDIR "$R0\${APP_FILENAME}"
        ${EndIf}
      ${EndIf}
      Pop $R1
      Pop $R0
    !endif
  !macroend
!endif
