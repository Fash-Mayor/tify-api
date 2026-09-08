@echo off
title spotDL Automated Downloader
color 0A

echo ============================================
echo      Spotify Downloader (spotDL) - BAT
echo ============================================
echo.

:menu
echo What do you want to download?
echo [1] Single Song
echo [2] Album
echo [3] Playlist
echo [4] Batch from File (e.g., songs.txt)
echo [5] Exit
echo.
set /p choice="Enter your choice (1-5): "

if "%choice%"=="1" goto single
if "%choice%"=="2" goto album
if "%choice%"=="3" goto playlist
if "%choice%"=="4" goto batch
if "%choice%"=="5" exit
goto menu

:single
cls
echo Enter Spotify track URL:
set /p url=
spotdl %url%
goto menu

:album
cls
echo Enter Spotify album URL:
set /p url=
spotdl %url%
goto menu

:playlist
cls
echo Enter Spotify playlist URL:
set /p url=
spotdl %url%
goto menu

:batch
cls
echo Enter full path to your .txt file with URLs (e.g., C:\Users\You\Desktop\songs.txt):
set /p filepath=
spotdl --list "%filepath%"
goto menu
