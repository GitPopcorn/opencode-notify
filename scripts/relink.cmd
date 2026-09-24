@ECHO OFF
SetLocal
@REM ================================================================
@REM  重建 kdco-notify-win 的缓存目录链接 (JUNCTION)
@REM
@REM  本文件由生成器产出，请勿手工修改
@REM      生成器  opencode-tool-devkit\relink-gen\gen_relink.ps1
@REM      模板    opencode-tool-devkit\relink-gen\relink.cmd.tpl
@REM      改法    改模板或改生成器里的目标清单后重新生成
@REM
@REM  背景
@REM      OpenCode 解析裸包名 spec 时，会把包定位到
@REM          %USERPROFILE%\.cache\opencode\packages\<spec>\node_modules\<name>
@REM      该路径存在即直接复用，不访问 npm registry，也不跑 arborist 安装
@REM      它属于 Cache，opencode uninstall 会删除且没有保留开关
@REM      本脚本用 JUNCTION 把缓存入口指回插件源码本体
@REM      于是插件真身留在本地仓库，opencode.jsonc 里只写包名
@REM
@REM  要点
@REM      JUNCTION 必须做在 <spec>\node_modules\<name> 这一层
@REM      只链接整个 <spec> 目录无效，OpenCode 会转去联网安装
@REM
@REM  行为
@REM      已就绪则直接返回，不做任何删除
@REM      仅在链接损坏时才移除旧链接，且不带 /S，不会递归进目标目录
@REM ================================================================

@REM STEP 插件参数 (本脚本唯一随插件而异的数据块，由生成器写入)
SET "PLUGIN_NAME=kdco-notify-win"
SET "PLUGIN_SPEC=kdco-notify-win@latest"
SET "PLUGIN_DIR_REL=..\dist\kdco-notify-win"
SET "PLUGIN_ENTRY=index.js"
SET "PLUGIN_CONFIG_FILE=opencode.jsonc"

@REM STEP 帮助参数
IF /I "%~1"=="Help"   GOTO :USAGE
IF /I "%~1"=="-Help"  GOTO :USAGE
IF /I "%~1"=="--Help" GOTO :USAGE
IF /I "%~1"=="-H"     GOTO :USAGE
IF /I "%~1"=="/?"     GOTO :USAGE

@REM STEP 把包根解析成绝对路径
SET "PLUGIN_DIR=%~dp0%PLUGIN_DIR_REL%"
FOR %%a IN ("%PLUGIN_DIR%") DO SET "PLUGIN_DIR=%%~fa"

SET "PKG_JSON=%PLUGIN_DIR%\package.json"
SET "ENTRY_FILE=%PLUGIN_DIR%\%PLUGIN_ENTRY%"

@REM STEP 哨兵 1：包清单必须存在
IF NOT EXIST "%PKG_JSON%" (
	ECHO [中止] 未找到包清单：%PKG_JSON%
	ECHO        请确认 PLUGIN_DIR_REL=[%PLUGIN_DIR_REL%] 是否指向正确的包根
	EXIT /B 1
)

@REM STEP 哨兵 2：入口文件必须存在
IF NOT EXIST "%ENTRY_FILE%" (
	ECHO [中止] 未找到入口文件：%ENTRY_FILE%
	ECHO        宿主的入口解析依赖 main 或 exports 指向的文件真实存在
	EXIT /B 1
)

@REM STEP 哨兵 3：包名必须与脚本声明一致
@REM NOTE 宿主用 spec 里的包名去拼缓存路径，名字写错即退化为联网安装
@REM NOTE 宽松解析：取包清单中含 name 的行，按冒号/空格/逗号切分后取第二个字段
SET "PKG_NAME="
FOR /F "tokens=2 delims=:, " %%a IN ('FINDSTR /I /C:"name" "%PKG_JSON%"') DO SET "PKG_NAME=%%~a"
IF NOT DEFINED PKG_NAME (
	ECHO [警告] 未能从包清单解析出 name 字段，跳过包名一致性校验
	ECHO        请人工确认包清单里声明了 name = %PLUGIN_NAME%
) ELSE (
	IF /I NOT "%PKG_NAME%"=="%PLUGIN_NAME%" (
		ECHO [中止] 包名与脚本声明不一致
		ECHO        包清单里的 name：[%PKG_NAME%]
		ECHO        脚本里的 PLUGIN_NAME：[%PLUGIN_NAME%]
		EXIT /B 4
	)
)

@REM STEP 组装缓存侧路径
SET "CACHE_ROOT=%USERPROFILE%\.cache\opencode\packages\%PLUGIN_SPEC%"
SET "CACHE_NM=%CACHE_ROOT%\node_modules"
SET "LINK_PATH=%CACHE_NM%\%PLUGIN_NAME%"
SET "SHELL_PKG=%CACHE_ROOT%\package.json"

@REM STEP 幂等短路：已就绪直接返回，避免无谓的删除动作
IF EXIST "%LINK_PATH%\package.json" (
	ECHO [就绪] %LINK_PATH%
	ECHO        已指向 %PLUGIN_DIR%
	EXIT /B 0
)

@REM STEP 建目录
IF NOT EXIST "%CACHE_ROOT%" MKDIR "%CACHE_ROOT%"
IF NOT EXIST "%CACHE_NM%" MKDIR "%CACHE_NM%"

@REM STEP 写外壳安装清单
@REM NOTE 该文件只供人眼识别与安装路径预演，不参与 OpenCode 的命中判定
> "%SHELL_PKG%" ECHO {
>>"%SHELL_PKG%" ECHO 	"dependencies": {
>>"%SHELL_PKG%" ECHO 		"%PLUGIN_NAME%": "latest"
>>"%SHELL_PKG%" ECHO 	}
>>"%SHELL_PKG%" ECHO }

@REM STEP 清理损坏的旧链接
@REM WARN 此处只用 RMDIR 不带 /S，只移除重解析点，不会递归删除目标目录内容
IF EXIST "%LINK_PATH%\" (
	ECHO [提示] 检测到损坏或过期的旧链接，先移除
	RMDIR "%LINK_PATH%" 2>NUL
)
IF EXIST "%LINK_PATH%\" (
	ECHO [中止] 旧链接无法自动移除，请手工删除该目录后重试
	ECHO        %LINK_PATH%
	EXIT /B 2
)

@REM STEP 创建 JUNCTION
@REM NOTE 刚移除失效链接后立刻用同名重建，偶发 "拒绝访问" (重解析点名称尚未释放)
@REM      故最多重试 3 次，每次间隔约 1 秒
SET "MKLINK_TRIES=0"

:MKLINK_TRY
MKLINK /J "%LINK_PATH%" "%PLUGIN_DIR%"
IF NOT ERRORLEVEL 1 GOTO :MKLINK_OK
SET /A MKLINK_TRIES+=1
IF %MKLINK_TRIES% GEQ 3 GOTO :MKLINK_FAIL
ECHO [提示] 链接创建失败，重试第 %MKLINK_TRIES% 次
PING -n 2 127.0.0.1 >NUL
GOTO :MKLINK_TRY

:MKLINK_FAIL
ECHO [失败] JUNCTION 目录链接创建失败 ^(已重试 3 次^)
ECHO        %LINK_PATH%
EXIT /B 1

:MKLINK_OK
@REM STEP 穿透校验
IF NOT EXIST "%LINK_PATH%\package.json" (
	ECHO [失败] 链接已建立但穿透校验不通过
	EXIT /B 1
)

ECHO [完成] %LINK_PATH%
ECHO        指向 %PLUGIN_DIR%
ECHO.
ECHO 请确认 %USERPROFILE%\.config\opencode\%PLUGIN_CONFIG_FILE% 的 plugin 数组里有：
ECHO     "%PLUGIN_SPEC%"
ECHO.
ECHO NOTE 本插件的 scripts\deploy.ps1 走的是把包复制进配置目录的旧模型，属遗留方式
ECHO.
ECHO 重启 OpenCode 生效
EXIT /B 0

:USAGE
ECHO 重建 kdco-notify-win 的缓存目录链接 ^(JUNCTION^)
ECHO.
ECHO 用法：
ECHO     relink.cmd                                执行重建
ECHO     relink.cmd [--Help^|-Help^|Help^|-H^|/^?]  显示本帮助
ECHO.
ECHO 何时需要：
ECHO     执行过 opencode uninstall
ECHO     手动清理过 %USERPROFILE%\.cache\opencode
ECHO     插件仓库换了路径或改了目录名
ECHO.
ECHO 说明：
ECHO     OpenCode 解析裸包名时，若缓存侧那两级路径已存在就直接复用，
ECHO     不访问 npm registry，本脚本就是把这个入口重新指回插件源码本体
ECHO.
ECHO     已就绪时脚本直接返回，不做任何删除
ECHO     仅在链接损坏时才用不带 /S 的 RMDIR 移除旧链接
ECHO.
ECHO 与 scripts\deploy.ps1 的关系：
ECHO     deploy.ps1 走的是把包复制进配置目录的旧模型，属遗留方式
ECHO     本脚本是当前主路径：不复制文件，只建立指向源码的目录链接
EXIT /B 0
