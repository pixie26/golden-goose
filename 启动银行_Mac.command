#!/bin/bash
cd "$(dirname "$0")" || exit 1
if ! command -v node >/dev/null 2>&1; then
  echo '未找到 Node.js，请先安装 Node.js 24（LTS）：https://nodejs.org/'
  read -r -p '按回车关闭...'
  exit 1
fi
if ! node -e "const [a,b]=process.versions.node.split('.').map(Number);process.exit(a>22||(a===22&&b>=8)?0:1)"; then
  echo "当前 Node.js $(node -v) 版本过旧，需要 22.8 或更新版本，推荐安装 Node.js 24（LTS）：https://nodejs.org/"
  read -r -p '按回车关闭...'
  exit 1
fi
printf '\n皇家金鹅银行启动中...\n请在浏览器打开 http://localhost:3000\n\n'
npm run dev
