@echo off
@REM setlocal
setlocal EnableDelayedExpansion
goto :main


:main
    set arr=%*
    set /a len=0

    for %%x in (%arr%) do ( set /a len = !len! + 1 )
    set /a len = !len! - 2

    if !len! LSS 0 ( EXIT /B 0 )

    @REM echo ============= destination
    set /a i=0
    set /a destindex = !len! + 1
    for %%x in (%arr%) do ( 
        if !i! EQU !destindex! ( set destination=%%~fx )
        set /a i = !i! + 1
    )

    @REM echo ========== sources
    set /a i=0

    for %%x in (%arr%) do (
        if !i! GTR !len! ( goto :out )
        set /a i = !i! + 1
        :: MAKING THE DIRECTORY AND COPY THE CONTENT
        mkdir %destination:~0,-1%\node_modules\%%~nx >nul 2>&1
        xcopy /E /C /Q /G /H /Y %%~fx %destination:~0,-1%\node_modules\%%~nx >nul 2>&1
        
    )
    :out


goto :eof
endlocal