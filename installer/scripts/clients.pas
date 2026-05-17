{ ===========================================================================
  clients.pas — MCP client detection and config wiring.

  Pulled into the [Code] section of gm-puppeteer.iss with an #include
  directive. Uses the global ClientDetected / ClientConfigPath /
  ClientItemIndex arrays and the ForgePage / ClientPage handles declared
  in the main script.

  Client indices: 0 Claude Desktop, 1 Cursor. Both are merged via the
  bundled merge-mcp.mjs helper.
  =========================================================================== }

const
  CLIENT_COUNT = 2;

function ClientId(I: Integer): String;
begin
  case I of
    0: Result := 'claude-desktop';
    1: Result := 'cursor';
  else
    Result := '';
  end;
end;

function ClientLabel(I: Integer): String;
begin
  case I of
    0: Result := 'Claude Desktop';
    1: Result := 'Cursor';
  else
    Result := '';
  end;
end;

{ Resolve the MSIX (Microsoft Store) Claude Desktop's sandboxed config path by
  scanning %LOCALAPPDATA%\Packages\Claude*. Prefers a package whose config file
  already exists, then one whose Roaming\Claude directory exists, then the first
  package directory found. Returns '' when no Claude MSIX package is installed. }
function FindClaudeMsixConfig: String;
var
  FR: TFindRec;
  Base, Cfg, WithDir, AnyPkg: String;
begin
  Result := '';
  WithDir := '';
  AnyPkg := '';
  Base := ExpandConstant('{localappdata}\Packages');
  if FindFirst(Base + '\Claude*', FR) then begin
    try
      repeat
        if (FR.Attributes and FILE_ATTRIBUTE_DIRECTORY) <> 0 then begin
          Cfg := Base + '\' + FR.Name +
            '\LocalCache\Roaming\Claude\claude_desktop_config.json';
          if FileExists(Cfg) then begin
            Result := Cfg;
            Exit;
          end;
          if (WithDir = '') and
             DirExists(Base + '\' + FR.Name + '\LocalCache\Roaming\Claude') then
            WithDir := Cfg;
          if AnyPkg = '' then AnyPkg := Cfg;
        end;
      until not FindNext(FR);
    finally
      FindClose(FR);
    end;
  end;
  if WithDir <> '' then Result := WithDir
  else Result := AnyPkg;
end;

{ Resolve Claude Desktop's config path. The Microsoft Store (MSIX) build keeps
  its config in a sandboxed per-package location and is checked FIRST: a stale
  %APPDATA%\Claude directory must not outrank a real MSIX package, or the entry
  gets written to a file the Store build never reads. Falls back to the standard
  %APPDATA% path for a standalone install. Returns '' when Claude Desktop is not
  installed. }
function FindClaudeDesktopConfig: String;
var
  Msix: String;
begin
  Msix := FindClaudeMsixConfig;
  if Msix <> '' then
    Result := Msix
  else if DirExists(ExpandConstant('{userappdata}\Claude')) or
          DirExists(ExpandConstant('{localappdata}\Programs\Claude')) then
    Result := ExpandConstant('{userappdata}\Claude\claude_desktop_config.json')
  else
    Result := '';
end;

{ Probe the machine for each supported MCP client. Read-only. }
procedure DetectClients;
var
  I: Integer;
begin
  for I := 0 to CLIENT_COUNT - 1 do begin
    ClientDetected[I] := False;
    ClientConfigPath[I] := '';
  end;

  { 0 — Claude Desktop }
  ClientConfigPath[0] := FindClaudeDesktopConfig;
  ClientDetected[0] := ClientConfigPath[0] <> '';

  { 1 — Cursor }
  if DirExists(ExpandConstant('{%USERPROFILE}\.cursor')) or
     DirExists(ExpandConstant('{localappdata}\Programs\cursor')) then begin
    ClientDetected[1] := True;
    ClientConfigPath[1] := ExpandConstant('{%USERPROFILE}\.cursor\mcp.json');
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

{ Merge a file-based client (Claude Desktop / Cursor) via the bundled
  merge-mcp.mjs helper. Returns False on a failed launch or non-zero exit
  code. }
function ConfigureFileClient(I: Integer): Boolean;
var
  Params: String;
  ResultCode: Integer;
begin
  Params := '"' + ExpandConstant('{app}\installer\merge-mcp.mjs') + '"' +
    ' --client ' + ClientId(I) +
    ' --config-path "' + ClientConfigPath[I] + '"' +
    ' --app-dir "' + ExpandConstant('{app}') + '"' +
    ' --action add';
  Result := Exec(NodeExe, Params, '', SW_HIDE, ewWaitUntilTerminated,
    ResultCode) and (ResultCode = 0);
  if not Result then
    Log('gm-puppeteer: failed to configure ' + ClientId(I) +
      ' (rc=' + IntToStr(ResultCode) + ')');
end;

{ Configure every ticked + detected client, recording the result in
  HKCU\Software\gm-puppeteer so the uninstaller can undo it. }
procedure ConfigureClients;
var
  I: Integer;
  Configured, Failed: String;
begin
  Configured := '';
  Failed := '';
  for I := 0 to CLIENT_COUNT - 1 do begin
    if ClientDetected[I] and ClientPage.Values[ClientItemIndex[I]] then begin
      if Configured <> '' then Configured := Configured + ',';
      Configured := Configured + ClientId(I);
      RegWriteStringValue(HKCU, 'Software\gm-puppeteer',
        'ConfigPath_' + ClientId(I), ClientConfigPath[I]);
      if not ConfigureFileClient(I) then begin
        if Failed <> '' then Failed := Failed + ', ';
        Failed := Failed + ClientLabel(I);
      end;
    end;
  end;
  RegWriteStringValue(HKCU, 'Software\gm-puppeteer',
    'ConfiguredClients', Configured);
  if Failed <> '' then
    MsgBox('GM-Puppeteer could not register with: ' + Failed + '.'
           + #13#10 + #13#10
           + 'The rest of the installation finished normally. The Setup log '
           + 'in your %TEMP% folder has the details.',
           mbError, MB_OK);
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
  Cfg, Params: String;
  ResultCode: Integer;
begin
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
