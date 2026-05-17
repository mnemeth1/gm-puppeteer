; ============================================================================
; gm-puppeteer.iss — Inno Setup script for the GM-Puppeteer Windows installer.
;
; Builds a per-user, self-contained installer that bundles a Node 24 runtime,
; the prebuilt dist/, production node_modules, and Chromium. The wizard collects
; the 12 environment settings into a .env file and can register the MCP server
; with detected clients (Claude Desktop, Claude Code, Cursor, OpenCode).
;
; Compiled by .github/workflows/build-installer.yml with:
;   ISCC.exe /DAppVersion=<v> /DChromeDir=<flattened chromium dir> gm-puppeteer.iss
;
; Defines (overridable on the ISCC command line):
;   AppVersion  — installer/app version string (default 0.0.0-dev)
;   StagingDir  — staging tree assembled by CI (default ..\staging)
;   ChromeDir   — flattened Chromium dir holding chrome.exe (default below)
; ============================================================================

#ifndef AppVersion
  #define AppVersion "0.0.0-dev"
#endif
#ifndef StagingDir
  #define StagingDir "..\staging"
#endif
#ifndef ChromeDir
  #define ChromeDir StagingDir + "\chromium"
#endif
#ifexist "assets\gm-puppeteer.ico"
  #define HaveIcon
#endif

[Setup]
AppId={{B3D7E1A2-4C56-4F8B-9A0E-7D2C3F1B6A84}
AppName=GM-Puppeteer
AppVersion={#AppVersion}
AppVerName=GM-Puppeteer {#AppVersion}
AppPublisher=gm-puppeteer
DefaultDirName={localappdata}\gm-puppeteer
DefaultGroupName=GM-Puppeteer
DisableWelcomePage=no
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
OutputDir=Output
OutputBaseFilename=gm-puppeteer-setup-{#AppVersion}
LicenseFile=..\UNLICENSE
Compression=lzma2/ultra
SolidCompression=yes
WizardStyle=modern
UninstallDisplayName=GM-Puppeteer
#ifdef HaveIcon
SetupIconFile=assets\gm-puppeteer.ico
#endif

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Files]
Source: "{#StagingDir}\node\*"; DestDir: "{app}\node"; Flags: recursesubdirs createallsubdirs ignoreversion
Source: "{#StagingDir}\dist\*"; DestDir: "{app}\dist"; Flags: recursesubdirs createallsubdirs ignoreversion
Source: "{#StagingDir}\node_modules\*"; DestDir: "{app}\node_modules"; Flags: recursesubdirs createallsubdirs ignoreversion
Source: "{#ChromeDir}\*"; DestDir: "{app}\chromium"; Flags: recursesubdirs createallsubdirs ignoreversion
Source: "merge-mcp.mjs"; DestDir: "{app}\installer"; Flags: ignoreversion
Source: "..\package.json"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\README.md"; DestDir: "{app}"; Flags: ignoreversion isreadme

[Icons]
Name: "{group}\Edit GM-Puppeteer configuration"; Filename: "{win}\notepad.exe"; Parameters: """{app}\.env"""
Name: "{group}\GM-Puppeteer install folder"; Filename: "{app}"
Name: "{group}\Uninstall GM-Puppeteer"; Filename: "{uninstallexe}"

[UninstallDelete]
; Catches files generated after install (.env, logs, .puppeteer-profile).
Type: filesandordirs; Name: "{app}"

[Code]
{ ----- Global state: page handles + control handles + client detection. ----- }
var
  FoundryPage:    TInputQueryWizardPage;
  BehaviorPage:   TWizardPage;
  SecurityPage:   TInputOptionWizardPage;
  ForgePage:      TInputQueryWizardPage;
  ClientPage:     TInputOptionWizardPage;

  LogLevelCombo:  TNewComboBox;
  TimeoutEdit:    TNewEdit;
  PacksEdit:      TNewEdit;
  HeadlessCheck:  TNewCheckBox;
  WarmCheck:      TNewCheckBox;

  ClientDetected:   array[0..3] of Boolean;
  ClientConfigPath: array[0..3] of String;
  ClientUsesCli:    array[0..3] of Boolean;
  ClientItemIndex:  array[0..3] of Integer;

#include "scripts\envpage.pas"
#include "scripts\clients.pas"

{ Copy the user's config aside on uninstall so a reinstall can restore it. }
procedure SaveUserData;
var
  Dest: String;
  ResultCode: Integer;
begin
  Dest := ExpandConstant('{localappdata}\gm-puppeteer-saved');
  ForceDirectories(Dest);
  if FileExists(ExpandConstant('{app}\.env')) then
    FileCopy(ExpandConstant('{app}\.env'), Dest + '\.env', False);
  if DirExists(ExpandConstant('{app}\.puppeteer-profile')) then
    Exec(ExpandConstant('{cmd}'),
      '/C xcopy /E /I /Y "' + ExpandConstant('{app}\.puppeteer-profile') +
        '" "' + Dest + '\.puppeteer-profile"',
      '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
end;

{ ----- Inno Setup event functions ----- }

procedure InitializeWizard;
begin
  DetectClients;
  CreateEnvPages;
  CreateClientPage;
end;

function ShouldSkipPage(PageID: Integer): Boolean;
begin
  { The Forge settings page is only relevant when FORGE_MODE is ticked. }
  Result := (PageID = ForgePage.ID) and (not SecurityPage.Values[1]);
end;

procedure CurPageChanged(CurPageID: Integer);
begin
  { The install directory is known by the time the Forge page shows — seed an
    absolute default for FORGE_PROFILE_DIR (relative paths resolve against the
    server's cwd, which the MCP client controls). }
  if (CurPageID = ForgePage.ID) and (Trim(ForgePage.Values[0]) = '') then
    ForgePage.Values[0] := ExpandConstant('{app}\.puppeteer-profile');
end;

function NextButtonClick(CurPageID: Integer): Boolean;
begin
  Result := True;
  if CurPageID = FoundryPage.ID then begin
    if Trim(FoundryPage.Values[0]) = '' then begin
      MsgBox('Please enter the Foundry server URL.', mbError, MB_OK);
      Result := False;
    end else if Trim(FoundryPage.Values[1]) = '' then begin
      MsgBox('Please enter the GM username.', mbError, MB_OK);
      Result := False;
    end;
  end;
end;

procedure CurStepChanged(CurStep: TSetupStep);
begin
  if CurStep = ssPostInstall then begin
    WriteEnvFile;
    ConfigureClients;
  end;
end;

procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
begin
  if CurUninstallStep = usUninstall then begin
    UnconfigureClients;
    if FileExists(ExpandConstant('{app}\.env')) or
       DirExists(ExpandConstant('{app}\.puppeteer-profile')) then begin
      if MsgBox('Keep your GM-Puppeteer configuration (.env) and saved Forge ' +
                'login session (.puppeteer-profile)?' + #13#10#13#10 +
                'Yes copies them to %LOCALAPPDATA%\gm-puppeteer-saved; ' +
                'No deletes everything.',
                mbConfirmation, MB_YESNO) = IDYES then
        SaveUserData;
    end;
  end;
  if CurUninstallStep = usPostUninstall then
    RegDeleteKeyIncludingSubkeys(HKCU, 'Software\gm-puppeteer');
end;
