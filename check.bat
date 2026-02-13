@echo off
set PATH=%USERPROFILE%\.cargo\bin;%PATH%
cd /d c:\Users\gokul\Downloads\CrabTree
cargo check --manifest-path src-tauri/Cargo.toml 2>&1
