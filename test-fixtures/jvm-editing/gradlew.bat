@echo off
rem Reuse the repository wrapper while keeping this fixture as the Gradle root.
call "%~dp0..\..\gradlew.bat" %*
