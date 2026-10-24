; Inno Setup 6 script for RetroHub-Setup.exe.
; Build:  ISCC.exe /DSourceDir=<staged BattleShip folder> /DAppVersion=1.12.0 /DOutputDir=<dir> RetroHub.iss
; (scripts\package-windows.ps1 does this for you.)
;
; Per-user install (no admin) into %LOCALAPPDATA%\Programs\RetroHub. User data
; (userdata\, saves, settings, the ROM-extracted BattleShip.o2r, logs) lives
; next to the exe and is never part of [Files], so upgrades and uninstalls
; leave it alone unless the user explicitly opts in to deleting it.

#ifndef SourceDir
  #error Pass /DSourceDir=<staged folder>
#endif
#ifndef AppVersion
  #define AppVersion "0.0.0"
#endif
#ifndef OutputDir
  #define OutputDir "."
#endif

[Setup]
; Fixed AppId: upgrades replace in place. KEEP IN SYNC with src/hub/updater.cpp.
AppId={{B7F3C1A2-5D4E-4F6A-9C8B-3E1D2A7F5C90}
AppName=RetroHub
AppVersion={#AppVersion}
AppVerName=RetroHub {#AppVersion}
AppPublisher=fatty8me2
AppPublisherURL=https://github.com/fatty8me2/smash-classic
AppSupportURL=https://github.com/fatty8me2/smash-classic/issues
AppUpdatesURL=https://github.com/fatty8me2/retrohub/releases
DefaultDirName={autopf}\RetroHub
DefaultGroupName=RetroHub
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
PrivilegesRequiredOverridesAllowed=dialog
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
UninstallDisplayName=RetroHub
UninstallDisplayIcon={app}\RetroHub.exe
SetupIconFile=retrohub.ico
OutputDir={#OutputDir}
OutputBaseFilename=RetroHub-Setup
Compression=lzma2/normal
SolidCompression=yes
CloseApplications=yes
RestartApplications=no
CloseApplicationsFilter=RetroHub.exe,n64run.exe,retrorun.exe,BattleShip.exe
WizardStyle=modern
LicenseFile={#SourceDir}\LICENSE.txt

[Tasks]
Name: "startmenuicon"; Description: "Create a &Start menu shortcut"; GroupDescription: "{cm:AdditionalIcons}"
Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"; GroupDescription: "{cm:AdditionalIcons}"

[Files]
Source: "{#SourceDir}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs; Excludes: "userdata,userdata\*,updates,updates\*,logs,logs\*,ssb64_save.bin,BattleShip.cfg.json,BattleShip.o2r,*.o2r.bak"

[Icons]
Name: "{autoprograms}\RetroHub"; Filename: "{app}\RetroHub.exe"; WorkingDir: "{app}"; Tasks: startmenuicon
Name: "{autodesktop}\RetroHub"; Filename: "{app}\RetroHub.exe"; WorkingDir: "{app}"; Tasks: desktopicon

[Registry]
; retrohub://join/<CODE> invite links (RetroHub also re-registers itself on every start).
Root: HKCU; Subkey: "Software\Classes\retrohub"; ValueType: string; ValueData: "URL:RetroHub Invite"; Flags: uninsdeletekey
Root: HKCU; Subkey: "Software\Classes\retrohub"; ValueType: string; ValueName: "URL Protocol"; ValueData: ""
Root: HKCU; Subkey: "Software\Classes\retrohub\DefaultIcon"; ValueType: string; ValueData: "{app}\RetroHub.exe,0"
Root: HKCU; Subkey: "Software\Classes\retrohub\shell\open\command"; ValueType: string; ValueData: """{app}\RetroHub.exe"" ""%1"""

[Run]
Filename: "{app}\RetroHub.exe"; Description: "{cm:LaunchProgram,RetroHub}"; WorkingDir: "{app}"; Flags: nowait postinstall skipifsilent

[UninstallDelete]
; Program folders only (the self-updater may add files the uninstall log does not know).
; userdata\, saves and BattleShip.o2r are intentionally NOT listed.
Type: filesandordirs; Name: "{app}\updates"
Type: filesandordirs; Name: "{app}\cores"
Type: filesandordirs; Name: "{app}\emu"
Type: filesandordirs; Name: "{app}\licenses"
Type: filesandordirs; Name: "{app}\.tcc"

[Code]
var
  GamesPage: TInputDirWizardPage;
  IsUpgrade: Boolean;

function UninstallKey: String;
begin
  Result := 'Software\Microsoft\Windows\CurrentVersion\Uninstall\{B7F3C1A2-5D4E-4F6A-9C8B-3E1D2A7F5C90}_is1';
end;

procedure InitializeWizard;
begin
  IsUpgrade := RegKeyExists(HKCU, UninstallKey) or RegKeyExists(HKLM, UninstallKey);
  GamesPage := CreateInputDirPage(wpSelectDir, 'Games folder',
    'Where do you keep your games?',
    'Setup creates this folder with a subfolder for each console. RetroHub scans it automatically. Put your game files here (or skip this and add your own folders later in RetroHub).',
    False, '');
  GamesPage.Add('');
  GamesPage.Values[0] := ExpandConstant('{param:GAMESDIR|{userdocs}\RetroHub Games}');
end;

function ShouldSkipPage(PageID: Integer): Boolean;
begin
  Result := IsUpgrade and (PageID = GamesPage.ID);   { never re-ask or re-add on upgrade }
end;

procedure CreateGamesFolder(const Root: String);
var
  Names: TArrayOfString;
  I: Integer;
begin
  SetArrayLength(Names, 11);
  Names[0] := 'GameCube';        Names[1] := 'Nintendo 64';
  Names[2] := 'Wii U';           Names[3] := '3DS';
  Names[4] := 'DS';              Names[5] := 'Game Boy Advance';
  Names[6] := 'Game Boy Color';  Names[7] := 'Game Boy';
  Names[8] := 'PlayStation';     Names[9] := 'PlayStation 2';
  Names[10] := 'BIOS';
  for I := 0 to 10 do ForceDirectories(Root + '\' + Names[I]);
  if not FileExists(Root + '\Put your games here.txt') then
    SaveStringToFile(Root + '\Put your games here.txt',
      'Put your games here.' + #13#10 + #13#10 +
      'Copy each game into the folder for its console. RetroHub scans this folder and its subfolders.' + #13#10 +
      'GameCube: .iso .gcm .rvz .wia .ciso .gcz' + #13#10 +
      'Nintendo 64: .z64 .v64 .n64    Wii U: .wua .wud .wux .rpx    3DS: .3ds .cci .cia .cxi' + #13#10 +
      'DS: .nds    Game Boy Advance: .gba    Game Boy Color: .gbc    Game Boy: .gb' + #13#10 +
      'PlayStation: .cue .chd .bin .pbp    PlayStation 2: .iso .chd .cso' + #13#10 +
      'BIOS: PlayStation / PlayStation 2 BIOS files (RetroHub never ships them; copy your own dumps here)' + #13#10 + #13#10 +
      'Uninstalling RetroHub never deletes this folder.' + #13#10, False);
end;

procedure CurStepChanged(CurStep: TSetupStep);
var
  Root: String;
begin
  if (CurStep = ssPostInstall) and not IsUpgrade then
  begin
    Root := RemoveBackslash(GamesPage.Values[0]);
    if Root = '' then Exit;
    CreateGamesFolder(Root);
    { Hand-off for RetroHub: merged into rom_folders on its first run, then deleted. }
    ForceDirectories(ExpandConstant('{app}\userdata'));
    SaveStringsToUTF8File(ExpandConstant('{app}\userdata\installer_games_dir.txt'), [Root], False);
  end;
end;

procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
var
  Dir: String;
begin
  if CurUninstallStep = usPostUninstall then
  begin
    Dir := ExpandConstant('{app}');
    if UninstallSilent then Exit;   { silent uninstall always keeps user data }
    if MsgBox('Also delete your saves, settings and friend identity?' + #13#10 +
              '(Your extracted game data, BattleShip.o2r, is kept either way.) Choose No to keep them (recommended if you may reinstall).',
              mbConfirmation, MB_YESNO or MB_DEFBUTTON2) = IDYES then
    begin
      DelTree(Dir + '\userdata', True, True, True);
      DelTree(Dir + '\logs', True, True, True);
      DeleteFile(Dir + '\ssb64_save.bin');
      DeleteFile(Dir + '\BattleShip.cfg.json');
      RemoveDir(Dir);
    end;
  end;
end;
