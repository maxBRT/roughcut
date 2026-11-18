# Dot-source this at the start of every PowerShell command:  . "<project>\tools\env.ps1"
$env:PATH = "$env:USERPROFILE\.cargo\bin;$env:LOCALAPPDATA\Programs\nodejs-portable;$env:LOCALAPPDATA\Microsoft\WinGet\Packages\Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe\ffmpeg-9.0.2-full_build\bin;$env:PATH"
# Rust GNU toolchain linker/resource tools (portable WinLibs MinGW-w64 UCRT, gcc 16.2) -- added by skeleton track
$env:PATH = "$env:LOCALAPPDATA\Programs\winlibs-mingw64\bin;$env:PATH"
$env:RUSTUP_TOOLCHAIN = "stable-x86_64-pc-windows-gnu"
