; MultiHeiz NSIS hooks (electron-builder include).
; - Firewall: program-scoped inbound Allow on Private, elevated/per-machine only.
;   Per-user (/currentuser) skips silently (netsh needs admin). Portable cannot add rules.
; - Uninstall: ask whether to delete %APPDATA%\<product> (default = keep).
;   Silent: keep data unless /DELETEDATA is passed. deleteAppDataOnUninstall stays false.
; - Upgrade: electron-builder already defaults to the same mode as an existing install
;   (per-machine if only HKLM, per-user if only HKCU). We warn if the user picks
;   per-user while a per-machine install exists, and remove stale product shortcuts
;   whose targets no longer exist.
; Uses ${PRODUCT_NAME} / ${PRODUCT_FILENAME} / ${SHORTCUT_NAME} so the installertest
; variant stays isolated.

!macro multiheizRemoveStaleShortcut lnkPath
  ; Delete ${lnkPath} only if it exists and its target path is missing.
  IfFileExists "${lnkPath}" 0 multiheiz_stale_done_${__LINE__}
    Push $R7
    Push $R8
    Push $R9
    StrCpy $R9 "${lnkPath}"
    ; Tiny PowerShell (no window): resolve .lnk target; remove if broken.
    ; Paths may contain spaces — pass via env to avoid quoting hell.
    System::Call 'Kernel32::SetEnvironmentVariable(t "MH_STALE_LNK", t "$R9")'
    nsExec::ExecToLog 'powershell -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -Command "$$p=$$env:MH_STALE_LNK; if (-not $$p) { exit 0 }; $$s=(New-Object -ComObject WScript.Shell).CreateShortcut($$p); $$t=$$s.TargetPath; if ($$t -and -not (Test-Path -LiteralPath $$t)) { Remove-Item -LiteralPath $$p -Force -ErrorAction SilentlyContinue }"'
    Pop $R8
    System::Call 'Kernel32::SetEnvironmentVariable(t "MH_STALE_LNK", i 0)'
    Pop $R9
    Pop $R8
    Pop $R7
  multiheiz_stale_done_${__LINE__}:
!macroend

!macro customInit
  ; Remove broken Start Menu / Desktop shortcuts left from old installs (target gone).
  ; Only touches our SHORTCUT_NAME — never other apps. Safe for installertest variant.
  ; Use $SMPROGRAMS/$DESKTOP (avoid "$PROGRAMDATA\...\Start Menu\..." — NSIS treats
  ; the space as ending the path and warns "unknown variable ...\Start").
  SetShellVarContext current
  !insertmacro multiheizRemoveStaleShortcut "$SMPROGRAMS\${SHORTCUT_NAME}.lnk"
  !insertmacro multiheizRemoveStaleShortcut "$DESKTOP\${SHORTCUT_NAME}.lnk"
  SetShellVarContext all
  !insertmacro multiheizRemoveStaleShortcut "$SMPROGRAMS\${SHORTCUT_NAME}.lnk"
  !insertmacro multiheizRemoveStaleShortcut "$DESKTOP\${SHORTCUT_NAME}.lnk"
  ; Restore shell context to match install mode chosen by initMultiUser.
  ${If} $installMode == "all"
    SetShellVarContext all
  ${Else}
    SetShellVarContext current
  ${EndIf}
!macroend

!macro customInstall
  ; Only attempt firewall rules when installing for all users (elevated).
  ${If} $installMode == "all"
    nsExec::ExecToLog 'netsh advfirewall firewall delete rule name="${PRODUCT_NAME}"'
    Pop $0
    nsExec::ExecToLog 'netsh advfirewall firewall add rule name="${PRODUCT_NAME}" dir=in action=allow program="$INSTDIR\${APP_EXECUTABLE_FILENAME}" enable=yes profile=private'
    Pop $0
    ; Ignore failure (no dialog) — rule is best-effort.
    DetailPrint "Firewall rule ${PRODUCT_NAME} (exit $0)"
  ${Else}
    DetailPrint "Skipping firewall rule (per-user install; needs elevation)"
  ${EndIf}

  ; Non-silent note: per-user chosen while a per-machine install already exists.
  ; (electron-builder already defaults the radio to "all users" when only HKLM exists.)
  ${If} $installMode == "CurrentUser"
  ${AndIf} $hasPerMachineInstallation == "1"
    IfSilent multiheiz_skip_dual_note
      MessageBox MB_ICONINFORMATION|MB_OK \
        "Já existe uma instalação de ${PRODUCT_NAME} para todos os usuários.$\r$\n$\r$\nInstalar só para o usuário atual pode criar atalhos e entradas duplicadas.$\r$\nRecomenda-se escolher «Todos os usuários» para atualizar a instalação existente."
    multiheiz_skip_dual_note:
  ${EndIf}
!macroend

!macro customUnInstall
  ; Remove firewall rule when elevated / all-users context.
  ${If} $installMode == "all"
    nsExec::ExecToLog 'netsh advfirewall firewall delete rule name="${PRODUCT_NAME}"'
    Pop $0
    DetailPrint "Firewall rule remove (exit $0)"
  ${EndIf}

  ; Ask about user data (default = No / keep). Skip prompt when silent.
  StrCpy $0 "0"
  IfSilent multiheiz_check_deletedata
  MessageBox MB_YESNO|MB_ICONQUESTION|MB_DEFBUTTON2 \
    "Apagar também os dados do ${PRODUCT_NAME} (perfis, sessões, configurações)?" \
    IDYES multiheiz_do_delete IDNO multiheiz_skip_delete
  multiheiz_do_delete:
    StrCpy $0 "1"
    Goto multiheiz_maybe_rm
  multiheiz_check_deletedata:
    ClearErrors
    ${GetParameters} $R0
    ${GetOptions} $R0 "/DELETEDATA" $R1
    ${IfNot} ${Errors}
      StrCpy $0 "1"
    ${EndIf}
  multiheiz_maybe_rm:
    ${If} $0 == "1"
      ; Electron userData = %APPDATA%\<productName> (MultiHeiz / MultiHeizInstallerTest)
      SetShellVarContext current
      RMDir /r "$APPDATA\${PRODUCT_FILENAME}"
      !ifdef APP_PRODUCT_FILENAME
        RMDir /r "$APPDATA\${APP_PRODUCT_FILENAME}"
      !endif
      DetailPrint "Removed userData under $APPDATA"
    ${EndIf}
  multiheiz_skip_delete:
!macroend
