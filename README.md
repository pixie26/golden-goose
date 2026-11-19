# 金鹅银行 · V2.0.3 上线前复核版

Royal Bank of the Golden Goose — Olivia 的家庭银行。

**这是 V2.0.3 源码包，可进入 Netlify 部署验收。** 承接 V2.0.2，现有 `schema: 2` 账本保持兼容，无需迁移。发布包不包含个人账本、真实密码、真实数据库连接串或已初始化的测试账户。测试代码仅使用虚构资料。

**V2.0.3：** 修正全球自选股的便士报价单位、弱网切换账户时旧响应误触发退出、定存到期前后提示，以及收盘后的撤单按钮和手动报价日期。股票自动顺延规则、资金计算与原有产品设计保持兼容。详见 [CHANGELOG.md](CHANGELOG.md)。

本轮在 **Node.js 24.22.1** 重新执行 `npm run verify`：**298 项测试，296 通过、0 失败、2 项真实数据库测试跳过**；另做 **12 组 / 9,600 步**非股票资金模拟，现金、预留、借款和流水对账均通过。**本轮未连接真实 PostgreSQL / Netlify / Supabase，未完成真实浏览器端到端测试，也未验证部署环境的 Yahoo 接口。** 历史版本的数据库、浏览器和打包记录已归档，不作为本轮验证结果。详见 [docs/ACCEPTANCE.md](docs/ACCEPTANCE.md)。

## 从哪里开始

| 目的 | 文档或命令 |
|---|---|
| 部署到 Netlify | [docs/NETLIFY.md](docs/NETLIFY.md) |
| 日常操作、备份和升级 | [docs/OPERATIONS.md](docs/OPERATIONS.md) |
| 本版具体修复 | [CHANGELOG.md](CHANGELOG.md) |
| 检查结果及上线验收 | [docs/ACCEPTANCE.md](docs/ACCEPTANCE.md) |
| 本地启动 | `npm ci`，然后 `npm run dev` |
| 完整自动化检查 | `npm run verify` |

## 本地运行

推荐 Node.js **24**，兼容 Node.js 22.8 以上。项目已有 `.node-version` 和 `package-lock.json`。

```bash
npm ci
npm run dev
```

打开 <http://localhost:3000>，首次设置密钥是 `local-setup`。设置家长密码（12–128 位）和 Olivia 的 PIN（6–10 位数字）后即可使用。

需要自定义配置时，复制 `.env.example` 为 `.env`；`npm run dev` 会读取该文件。**只做本地体验时，不需要填写 `DATABASE_URL`。** 默认账本保存在项目的 `data/bank.local.json`。

安装依赖后，也可以双击根目录的 `启动银行_Mac.command` / `启动银行_Windows.bat`。Mac 若解压工具未保留执行权限，可在项目目录运行 `chmod +x 启动银行_Mac.command`。家人要从同一个可信 Wi-Fi 的手机打开时使用 `npm run lan`，以终端显示的局域网地址为准。本地 JSON 模式只运行一个服务实例；多人连接同一实例不受影响。

## 部署配置

| 设置 | 值 |
|---|---|
| Node.js | `24`，配置已写入项目 |
| Build command | `npm run build` |
| Publish directory | `public` |
| Functions directory | `netlify/functions` |
| API | `/api/*` |
| 必填环境变量 | `DATABASE_URL`、`SETUP_TOKEN`（可选 `DATABASE_CA_CERT`，见部署指南） |
| 日常结算 | 香港时间 17:30、06:30 |

建议 Git 仓库连接 Netlify。不能仅上传 `public/`，因为登录、记账和结算都依赖服务端函数及 PostgreSQL。逐步说明见 [NETLIFY.md](docs/NETLIFY.md)。

## 功能与既定规则

- Olivia 与家长分别登录，服务器负责权限和余额校验。
- O$ 与 HKD 按 1:1 约定；家长直接记入有真实资金背书的余额。
- 定期存款、购物审批及一次退款、借款和还款、任务奖励、心愿购买。
- 港美股票 / ETF 的碎股模拟交易，按对应交易日收盘价成交；美股固定 USD 1 = O$ 8。
- 最多十只自选股票，展示收盘价、日 / 周 / YTD 表现；Yahoo 不可用时不生成虚构价格。
- 金额统一显示一位小数；实际现金账务保存到分。
- 定存、借款、心愿、家长待处理、家长任务管理和待成交订单默认全部时间；其他记录默认最近三十天，每页十条。
- 已选定的粉色银行背景、金鹅头像、牛油果浏览器图标和首页自选股位置保持原设计。

## 文件架构

| 路径 | 职责 |
|---|---|
| `public/index.html`、`app.js`、`style.css` | 网页入口、页面交互和样式 |
| `public/assets/images/` | 银行背景、金鹅、功能图案 |
| `public/assets/icons/` | 牛油果 favicon、手机与桌面图标 |
| `lib/core.mjs` | 业务、账务、权限、幂等、结算 |
| `lib/store.mjs` | 本地原子文件保存 / PostgreSQL 事务 |
| `lib/api.mjs` | HTTP、会话、输入校验与 API |
| `lib/market.mjs`、`quotes.mjs`、`local-search.mjs` | 交易日历、Yahoo 行情及明确标记的离线搜索 |
| `netlify/functions/` | API 函数和每日结算函数 |
| `scripts/check.mjs` | 构建前语法、版本和静态资源检查 |
| `tests/` | 按功能命名的自动化回归测试 |
| `.github/workflows/ci.yml` | GitHub 提交与 PR 时的自动检查 |
| `docs/` | 当前部署、使用和验收说明 |
| `docs/verification/` | V2.0.3 本轮实际检查输出与可重跑模拟脚本 |
| `docs/archive/` | 历史验收与旧版验证输出，按版本归档 |
| `docs/design/` | 已确认背景和金鹅图标源图；不随网页发布 |

前端保留无需框架构建的结构，后端继续分离业务、存储、接口和行情职责。旧截图和不再引用的旧版图标已从正式包移除。只有 `public/` 会作为网页文件公开。

## 升级已有账本

先备份，再替换代码并运行 `npm ci`。本地保留原 `data/` 或 `BANK_DATA_FILE` 指向的文件；线上继续使用原 `DATABASE_URL`。若旧版已经发生股票乱序成交，先按升级文档核对成本与盈亏；本版会暂停跨越已成交历史的订单，避免继续错算。从 V2.0.1 升级后的第一次结算，会把成交日已过、当天没有收盘价但之后已有价格的待成交订单按之后第一个收盘价成交，详见 [OPERATIONS.md](docs/OPERATIONS.md) 的升级说明。**不要重新初始化或覆盖旧账本。** 本地 JSON 不会自动上传到 Netlify；有真实旧数据时请按 [OPERATIONS.md](docs/OPERATIONS.md) 单独安排迁移及核对。

## 当前边界

这是家庭账本与投资学习工具，不会执行真实银行转账或券商交易。Yahoo 为非官方行情来源；分红、拆合股和退市等公司行动尚未自动处理（退市后可由家长撤销卡住的订单）。交易日历不需要每年更新：日历未知的休市会自动顺延到之后第一个收盘价。部署后需要验证真实数据库连接、Yahoo 访问、定时执行及常用手机浏览器。

免费套餐用量：Netlify 免费版每月 300 credits，每次正式部署扣 15，用完后站点暂停至下个计费周期；Supabase 免费版每月 5 GB 出站流量。V2.0.0 起页面刷新几乎不再产生数据库流量，但上线初期频繁部署仍可能先耗尽 Netlify 额度。具体见 [NETLIFY.md](docs/NETLIFY.md)。
