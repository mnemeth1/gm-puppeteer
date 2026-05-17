{ ===========================================================================
  clients.pas — MCP client detection and config wiring.

  Pulled into the [Code] section of gm-puppeteer.iss with an #include
  directive. Uses the global ClientDetected / ClientConfigPath /
  ClientUsesCli / ClientItemIndex arrays and the ForgePage / ClientPage
  handles declared in the main script.

  Client indices: 0 Claude Desktop, 1 Claude Code, 2 Cursor, 3 OpenCode.
  These are merged via the bundled merge-mcp.mjs helper; Claude Code, when
  its CLI is present, is configured through `claude mcp add` instead.
  =========================================================================== }

const
  CLIENT_COUNT = 4;

function ClientId(I: Integer): String;
begin
  case I of
    0: Result := 'claude-desktop';
    1: Result := 'claude-code';
    2: Result := 'cursor';
    3: Result := 'opencode';
  else
    Result := '';
  end;
end;

function ClientLabel(I: Integer): String;
begin
  case I of
    0: Result := 'Claude Desktop';
    1: Result := 'Claude Code';
    2: Result := 'Cursor';
    3: Result := 'OpenCode';
  else
    Result := '';
  end;
end;

function B01(B: Boolean): String;
begin
  if B then Result := '1' else Result := '0';
end;

{ True if `Exe` resolves on PATH (via `where`). }
function CommandOnPath(Exe: String): Boolean;
var
  ResultCode: Integer;
begin
  Result := Exec(ExpandConstant('{cmd}'), '/C where ' + Exe + ' >nul 2>nul',
    '', SW_HIDE, ewWaitUntilTerminated, ResultCode) and (ResultCode = 0);
end;

{ Resolve Claude Desktop's config path: the standard %APPDATA% location when
  present, else the MSIX (Microsoft Store) sandboxed path. Returns '' when
  Claude Desktop is not installed. }
function FindClaudeDesktopConfig: String;
var
  FR: TFindRec;
  Base: String;
begin
  Result := '';
  if DirExists(ExpandConstant('{userappdata}\Claude')) or
     DirExists(ExpandConstant('{localappdata}\Programs\Claude')) then begin
    Result := ExpandConstant('{userappdata}\Claude\claude_desktop_config.json');
    Exit;
  end;
  Base := ExpandConstant('{localappdata}\Packages');
  if FindFirst(Base + '\Claude*', FR) then begin
    try
      repeat
        if (FR.Attributes and FILE_ATTRIBUTE_DIRECTORY) <> 0 then begin
          Result := Base + '\' + FR.Name +
            '\LocalCache\Roaming\Claude\claude_desktop_config.json';
          Exit;
        end;
      until not FindNext(FR);
    finally
      FindClose(FR);
    end;
  end;
end;

{ Probe the machine for each supported MCP client. Read-only. }
procedure DetectClients;
var
  I: Integer;
begin
  for I := 0 to CLIENT_COUNT - 1 do begin
    ClientDetected[I] := False;
    ClientConfigPath[I] := '';
    ClientUsesCli[I] := False;
  end;

  { 0 — Claude Desktop }
  ClientConfigPath[0] := FindClaudeDesktopConfig;
  ClientDetected[0] := ClientConfigPath[0] <> '';

  { 1 — Claude Code: prefer the `claude` CLI, else the user config file. }
  if CommandOnPath('claude') then begin
    ClientDetected[1] := True;
    ClientUsesCli[1] := True;
  end else if FileExists(ExpandConstant('{%USERPROFILE}\.claude.json')) then begin
    ClientDetected[1] := True;
    ClientConfigPath[1] := ExpandConstant('{%USERPROFILE}\.claude.json');
  end;

  { 2 — Cursor }
  if DirExists(ExpandConstant('{%USERPROFILE}\.cursor')) or
     DirExists(ExpandConstant('{localappdata}\Programs\cursor')) then begin
    ClientDetected[2] := True;
    ClientConfigPath[2] := ExpandConstant('{%USERPROFILE}\.cursor\mcp.json');
  end;

  { 3 — OpenCode }
  if DirExists(ExpandConstant('{%USERPROFILE}\.config\opencode')) or
     CommandOnPath('opencode') then begin
    ClientDetected[3] := True;
    ClientConfigPath[3] :=
      ExpandConstant('{%USERPROFILE}\.config\opencode\opencode.json');
  end;
end;

{ Build the MCP-client checkbox page. Undetected clients are listed but
  disabled; every checkbox starts unticked. }
procedure CreateClientPage;
var
  I: Integer;
  Caption: String;
begin
  ClientPage := CreateInputOptionPage(ForgePage.ID,
    'Connect MCP clients',
    'Optionally register gm-puppeteer with the AI clients on this PC.',
    'Each ticked client gets a "gm-puppeteer" entry merged into its config; ' +
    'a timestamped backup is written first. All boxes start unticked.',
    False, False);
  for I := 0 to CLIENT_COUNT - 1 do begin
    if ClientDetected[I] then
      Caption := ClientLabel(I)
    else
      Caption := ClientLabel(I) + '   (not found)';
    ClientItemIndex[I] := ClientPage.Add(Caption);
    ClientPage.Values[ClientItemIndex[I]] := False;
    if not ClientDetected[I] then
      ClientPage.CheckListBox.ItemEnabled[ClientItemIndex[I]] := False;
  end;
end;

{ ----- Configuration (install time) ----- }

function NodeExe: String;
begin
  Result := ExpandConstant('{app}\node\node.exe');
end;

{ Merge a file-based client (Claude Desktop / Cursor / OpenCode, and Claude
  Code's fallback) via the bundled merge-mcp.mjs helper. }
procedure ConfigureFileClient(I: Integer);
var
  Params: String;
  ResultCode: Integer;
begin
  Params := '"' + ExpandConstant('{app}\installer\merge-mcp.mjs') + '"' +
    ' --client ' + ClientId(I) +
    ' --config-path "' + ClientConfigPath[I] + '"' +
    ' --app-dir "' + ExpandConstant('{app}') + '"' +
    ' --action add';
  if (not Exec(NodeExe, Params, '', SW_HIDE, ewWaitUntilTerminated, ResultCode))
     or (ResultCode <> 0) then
    Log('gm-puppeteer: failed to configure ' + ClientId(I) +
      ' (rc=' + IntToStr(ResultCode) + ')');
end;

{ Register with Claude Code through its CLI (user scope). }
procedure ConfigureClaudeCli;
var
  Params: String;
  ResultCode: Integer;
begin
  Params := '/C claude mcp add gm-puppeteer --scope user -- ' +
    '"' + NodeExe + '" ' +
    '"--env-file=' + ExpandConstant('{app}\.env') + '" ' +
    '"' + ExpandConstant('{app}\dist\index.js') + '"';
  if (not Exec(ExpandConstant('{cmd}'), Params, '', SW_HIDE,
       ewWaitUntilTerminated, ResultCode)) or (ResultCode <> 0) then
    Log('gm-puppeteer: claude mcp add failed (rc=' + IntToStr(ResultCode) + ')');
end;

{ Configure every ticked + detected client, recording the result in
  HKCU\Software\gm-puppeteer so the uninstaller can undo it. }
procedure ConfigureClients;
var
  I: Integer;
  Configured: String;
begin
  Configured := '';
  for I := 0 to CLIENT_COUNT - 1 do begin
    if ClientDetected[I] and ClientPage.Values[ClientItemIndex[I]] then begin
      case I of
        0, 2, 3: ConfigureFileClient(I);
        1:
          if ClientUsesCli[1] then ConfigureClaudeCli
          else ConfigureFileClient(1);
      end;
      if Configured <> '' then Configured := Configured + ',';
      Configured := Configured + ClientId(I);
      RegWriteStringValue(HKCU, 'Software\gm-puppeteer',
        'ConfigPath_' + ClientId(I), ClientConfigPath[I]);
      RegWriteStringValue(HKCU, 'Software\gm-puppeteer',
        'Cli_' + ClientId(I), B01(ClientUsesCli[I]));
    end;
  end;
  RegWriteStringValue(HKCU, 'Software\gm-puppeteer',
    'ConfiguredClients', Configured);
end;

{ ----- Unconfiguration (uninstall time) ----- }

procedure SplitCsv(S: String; Dest: TStringList);
var
  P: Integer;
begin
  Dest.Clear;
  S := Trim(S);
  while S <> '' do begin
    P := Pos(',', S);
    if P = 0 then begin
      Dest.Add(Trim(S));
      S := '';
    end else begin
      Dest.Add(Trim(Copy(S, 1, P - 1)));
      Delete(S, 1, P);
    end;
  end;
end;

{ Remove only the gm-puppeteer entry from one client, leaving siblings intact.
  Runs while the bundled Node + merge-mcp.mjs still exist (usUninstall fires
  before files are deleted). }
procedure RemoveClientEntry(Id: String);
var
  Cfg, UsesCli, Params: String;
  ResultCode: Integer;
begin
  RegQueryStringValue(HKCU, 'Software\gm-puppeteer', 'Cli_' + Id, UsesCli);
  if (Id = 'claude-code') and (UsesCli = '1') then begin
    Exec(ExpandConstant('{cmd}'),
      '/C claude mcp remove gm-puppeteer --scope user',
      '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
    Exit;
  end;

  if not RegQueryStringValue(HKCU, 'Software\gm-puppeteer',
       'ConfigPath_' + Id, Cfg) then Exit;
  if Cfg = '' then Exit;
  Params := '"' + ExpandConstant('{app}\installer\merge-mcp.mjs') + '"' +
    ' --client ' + Id + ' --config-path "' + Cfg + '" --action remove';
  Exec(ExpandConstant('{app}\node\node.exe'), Params, '', SW_HIDE,
    ewWaitUntilTerminated, ResultCode);
end;

procedure UnconfigureClients;
var
  Configured: String;
  List: TStringList;
  I: Integer;
begin
  if not RegQueryStringValue(HKCU, 'Software\gm-puppeteer',
       'ConfiguredClients', Configured) then Exit;
  if Trim(Configured) = '' then Exit;
  List := TStringList.Create;
  try
    SplitCsv(Configured, List);
    for I := 0 to List.Count - 1 do
      if List[I] <> '' then
        RemoveClientEntry(List[I]);
  finally
    List.Free;
  end;
end;
