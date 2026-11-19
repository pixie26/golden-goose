@echo off
chcp 65001 > nul
cd /d "%~dp0"
where node > nul 2>&1
if errorlevel 1 (
  echo 未找到 Node.js，请先安装 Node.js 24（LTS）：https://nodejs.org/
  pause
  exit /b 1
)
node -e "const [a,b]=process.versions.node.split('.').map(Number);process.exit(a>22||(a===22&&b>=8)?0:1)"
if errorlevel 1 (
  echo 当前 Node.js 版本过旧，需要 22.8 或更新版本，推荐安装 Node.js 24（LTS）：https://nodejs.org/
  pause
  exit /b 1
)
echo 打开浏览器：http://localhost:3000
call npm run dev
pause
