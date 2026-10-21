; MultiHeiz NSIS hooks (electron-builder include).
; - Firewall: program-scoped inbound Allow on Private, elevated/per-machine only.
;   Per-user (/currentuser) skips silently (netsh needs admin). Portable cannot add rules.
; - Uninstall: ask whether to delete %APPDATA%\<product> (default = keep).
;   Silent: keep data unless /DELETEDATA is passed. deleteAppDataOnUninstall stays false.
; Uses ${PRODUCT_NAME} / ${PRODUCT_FILENAME} so the installertest variant stays isolated.

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
