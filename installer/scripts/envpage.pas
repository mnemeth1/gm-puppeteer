{ ===========================================================================
  envpage.pas — custom wizard pages collecting the 11 environment settings.

  Pulled into the [Code] section of gm-puppeteer.iss with an #include
  directive. The page handles and control handles it assigns (FoundryPage,
  BehaviorPage, SecurityPage, ForgePage, LogLevelCombo, TimeoutEdit,
  HeadlessCheck, WarmCheck) are declared in the main script's global var
  block.
  =========================================================================== }

function BoolStr(B: Boolean): String;
begin
  if B then Result := 'true' else Result := 'false';
end;

{ Create the four env-var pages, inserted after the Select-Directory page. }
procedure CreateEnvPages;
var
  Lbl: TNewStaticText;
  Y: Integer;
begin
  { --- Page 1: Foundry connection --- }
  FoundryPage := CreateInputQueryPage(wpSelectDir,
    'Foundry connection',
    'How should the server reach your Foundry VTT world?',
    'These become FOUNDRY_URL, FOUNDRY_GM_USERNAME and FOUNDRY_GM_PASSWORD ' +
    'in the generated .env file.');
  FoundryPage.Add('Foundry server URL:', False);
  FoundryPage.Add('GM username (the user the server logs in as):', False);
  FoundryPage.Add('GM password (leave blank if the user has none):', True);
  FoundryPage.Values[0] := 'http://localhost:30000';
  FoundryPage.Values[1] := 'AI-GM';
  FoundryPage.Values[2] := '';

  { --- Page 2: Server behavior (custom controls) --- }
  BehaviorPage := CreateCustomPage(FoundryPage.ID,
    'Server behavior',
    'Logging, the login timeout, and compendium cache warming.');

  Y := 0;
  Lbl := TNewStaticText.Create(BehaviorPage);
  Lbl.Parent := BehaviorPage.Surface;
  Lbl.Top := Y;
  Lbl.AutoSize := True;
  Lbl.Caption := 'Log level (LOG_LEVEL):';

  Y := Y + ScaleY(18);
  LogLevelCombo := TNewComboBox.Create(BehaviorPage);
  LogLevelCombo.Parent := BehaviorPage.Surface;
  LogLevelCombo.Top := Y;
  LogLevelCombo.Width := ScaleX(160);
  LogLevelCombo.Style := csDropDownList;
  LogLevelCombo.Items.Add('trace');
  LogLevelCombo.Items.Add('debug');
  LogLevelCombo.Items.Add('info');
  LogLevelCombo.Items.Add('warn');
  LogLevelCombo.Items.Add('error');
  LogLevelCombo.ItemIndex := 2;

  Y := Y + ScaleY(34);
  Lbl := TNewStaticText.Create(BehaviorPage);
  Lbl.Parent := BehaviorPage.Surface;
  Lbl.Top := Y;
  Lbl.AutoSize := True;
  Lbl.Caption := 'Login timeout in milliseconds (FOUNDRY_LOGIN_TIMEOUT_MS):';

  Y := Y + ScaleY(18);
  TimeoutEdit := TNewEdit.Create(BehaviorPage);
  TimeoutEdit.Parent := BehaviorPage.Surface;
  TimeoutEdit.Top := Y;
  TimeoutEdit.Width := ScaleX(120);
  TimeoutEdit.Text := '60000';

  Y := Y + ScaleY(36);
  HeadlessCheck := TNewCheckBox.Create(BehaviorPage);
  HeadlessCheck.Parent := BehaviorPage.Surface;
  HeadlessCheck.Top := Y;
  HeadlessCheck.Width := BehaviorPage.SurfaceWidth;
  HeadlessCheck.Caption := 'Run Chromium headless (FOUNDRY_HEADLESS)';
  HeadlessCheck.Checked := True;

  Y := Y + ScaleY(22);
  WarmCheck := TNewCheckBox.Create(BehaviorPage);
  WarmCheck.Parent := BehaviorPage.Surface;
  WarmCheck.Top := Y;
  WarmCheck.Width := BehaviorPage.SurfaceWidth;
  WarmCheck.Caption := 'Pre-warm the compendium cache on start ' +
    '(WARM_COMPENDIUM_ON_START)';
  WarmCheck.Checked := True;

  { --- Page 3: Advanced / security --- }
  SecurityPage := CreateInputOptionPage(BehaviorPage.ID,
    'Advanced and security options',
    'Leave both unticked unless you know you need them.',
    'ALLOW_EVAL exposes a tool that runs arbitrary JavaScript inside your ' +
    'Foundry world — only enable it for server development. FORGE_MODE is ' +
    'for Foundry worlds hosted on forge-vtt.com.',
    False, False);
  SecurityPage.Add('Enable the foundry_eval tool (ALLOW_EVAL) — security risk');
  SecurityPage.Add('This is a Forge-hosted world (FORGE_MODE)');
  SecurityPage.Values[0] := False;
  SecurityPage.Values[1] := False;

  { --- Page 4: Forge settings (skipped unless FORGE_MODE is ticked) --- }
  ForgePage := CreateInputQueryPage(SecurityPage.ID,
    'Forge-hosted Foundry settings',
    'Only used when FORGE_MODE is enabled.',
    'The browser profile directory persists your Forge login between runs; ' +
    'treat it like a credential.');
  ForgePage.Add('Profile directory (absolute path recommended):', False);
  ForgePage.Add('Manual login timeout in milliseconds:', False);
  ForgePage.Values[0] := '';
  ForgePage.Values[1] := '300000';
end;

{ Write the collected settings to the .env file after files are installed.
  Note: Pascal block comments must not contain a closing brace, so install-
  dir constants are spelled out in prose here rather than as app-dir tokens. }
procedure WriteEnvFile;
var
  Lines: TArrayOfString;
  Path, ForgeProfile: String;
begin
  ForgeProfile := Trim(ForgePage.Values[0]);
  if ForgeProfile = '' then
    ForgeProfile := ExpandConstant('{app}\.puppeteer-profile');

  { The compendium warm picks packs automatically by document-type priority
    and a document budget, so no game-system or pack list is collected here.
    Advanced users can add WARM_PHASE2_PACKS or WARM_DOC_BUDGET to the .env. }
  SetArrayLength(Lines, 15);
  Lines[0]  := '# Generated by the GM-Puppeteer installer. Edit and restart';
  Lines[1]  := '# your MCP client to apply changes.';
  Lines[2]  := 'FOUNDRY_URL=' + Trim(FoundryPage.Values[0]);
  Lines[3]  := 'FOUNDRY_GM_USERNAME=' + Trim(FoundryPage.Values[1]);
  Lines[4]  := 'FOUNDRY_GM_PASSWORD=' + FoundryPage.Values[2];
  Lines[5]  := 'FOUNDRY_HEADLESS=' + BoolStr(HeadlessCheck.Checked);
  Lines[6]  := 'FOUNDRY_LOGIN_TIMEOUT_MS=' + Trim(TimeoutEdit.Text);
  Lines[7]  := 'LOG_LEVEL=' + LogLevelCombo.Text;
  Lines[8]  := 'WARM_COMPENDIUM_ON_START=' + BoolStr(WarmCheck.Checked);
  Lines[9]  := 'ALLOW_EVAL=' + BoolStr(SecurityPage.Values[0]);
  Lines[10] := 'FORGE_MODE=' + BoolStr(SecurityPage.Values[1]);
  Lines[11] := 'FORGE_PROFILE_DIR=' + ForgeProfile;
  Lines[12] := 'FORGE_MANUAL_LOGIN_TIMEOUT_MS=' + Trim(ForgePage.Values[1]);
  Lines[13] := 'PUPPETEER_EXECUTABLE_PATH=' + ExpandConstant('{app}\chromium\chrome.exe');
  Lines[14] := 'PUPPETEER_CACHE_DIR=' + ExpandConstant('{app}\chromium');

  Path := ExpandConstant('{app}\.env');
  if not SaveStringsToFile(Path, Lines, False) then
    MsgBox('Failed to write the configuration file:' + #13#10 + Path,
      mbError, MB_OK);
end;
