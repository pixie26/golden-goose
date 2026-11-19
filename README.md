# 金鹅银行 · Royal Bank of the Golden Goose

![金鹅银行](public/assets/images/hero-fairytale.png)

![version](https://img.shields.io/badge/version-2.1-ff69b4)
![Node.js](https://img.shields.io/badge/Node.js-%E2%89%A522.8-339933?logo=nodedotjs&logoColor=white)
![tests](https://img.shields.io/badge/tests-322%20%E9%A1%B9%20%C2%B7%200%20%E5%A4%B1%E8%B4%A5-success)
![deploy](https://img.shields.io/badge/deploy-Netlify-00AD9F?logo=netlify&logoColor=white)

一个自托管的**家庭银行与投资学习应用**。孩子在「金鹅银行」里领取任务奖励、存定期存款、申请购物、购买心愿，并用零花钱进行港美股碎股模拟投资；家长负责记账、审批和行情维护。所有账务、权限和余额校验都在服务端完成。

> ⚠️ 这是记账与教育工具：不连接任何真实银行或券商，不会发生真实资金变动。

## 功能

### 账户与安全

- 孩子、家长双角色登录：孩子使用 6–10 位数字 PIN，家长使用 12–128 位密码
- 会话、权限、余额校验全部在服务端完成；多设备可同时在线
- 幂等与审计记录，防止重复入账；换账号登录不会串数据

### 银行功能

- **货币**：O$ 与 HKD 按 1:1 约定，家长记入的余额有真实资金背书
- **定期存款**：到期取回计息，提前赎回不计息
- **购物审批**：孩子申请，家长批准；每笔支持一次退款
- **借款与还款**、**任务奖励**、**心愿购买**
- **站内通知**：定存到期提醒、审批结果、成交与撤销等
- 记录默认最近三十天、每页十条；定存 / 借款 / 心愿 / 家长待处理等列表默认显示全部时间
- 金额统一显示一位小数，实际账务保存到分

### 投资学习

- 港美股票 / ETF 的**碎股模拟交易**，按对应交易日收盘价成交（美股固定 USD 1 = O$ 8）
- 交易日历内置港股 2026–2027、美股 2026–2028，其后按交易所规则自动计算；日历未知的休市自动顺延到之后第一个真实收盘价，无需每年维护
- 最多十只自选股票，展示收盘价与日 / 周 / YTD 表现
- Yahoo 行情不可用时如实显示等待，**不生成虚构价格**；家长可手动登记收盘价
- 停牌 / 退市卡住的订单，家长可在收市后撤销，冻结资金或股票自动退回

### 界面

- 无框架单页应用，粉色童话银行背景、金鹅形象、牛油果图标
- 手机与桌面自适应，提供 webmanifest 与全尺寸图标，可添加到主屏幕

## 快速开始（本地）

推荐 Node.js 24，兼容 22.8 以上：

```bash
npm ci
npm run dev
```

打开 <http://localhost:3000>，首次设置密钥是 `local-setup`，设置家长密码和孩子 PIN 后即可使用。本地模式账本保存在 `data/bank.local.json`（已被 `.gitignore` 忽略），**不需要配置数据库**。

- 家人从同一 Wi-Fi 的手机访问：`npm run lan`
- 也可以直接双击 `启动银行_Windows.bat` / `启动银行_Mac.command`（Mac 首次需 `chmod +x`）

## 部署

推荐 Netlify + PostgreSQL（如 Supabase），仓库连接 Netlify 后按下表配置即可：

| 设置 | 值 |
|---|---|
| Build command | `npm run build` |
| Publish directory | `public` |
| Functions directory | `netlify/functions` |
| 必填环境变量 | `DATABASE_URL`、`SETUP_TOKEN` |
| 可选环境变量 | `DATABASE_CA_CERT`（校验数据库证书） |
| 日常结算 | 香港时间 17:30、06:30 |

逐步说明见 [docs/NETLIFY.md](docs/NETLIFY.md)；日常备份、升级和数据迁移见 [docs/OPERATIONS.md](docs/OPERATIONS.md)。

## 架构

前端保留无需框架构建的结构，后端按业务、存储、接口、行情分层；运行时依赖只有 `pg`。

| 路径 | 职责 |
|---|---|
| `public/` | 单页前端（`index.html` / `app.js` / `style.css`）与静态资源 |
| `lib/core.mjs` | 业务、账务、权限、幂等、结算 |
| `lib/store.mjs` | 本地原子文件保存 / PostgreSQL 事务 |
| `lib/api.mjs` | HTTP、会话、输入校验与 API |
| `lib/market.mjs`、`quotes.mjs`、`local-search.mjs` | 交易日历、Yahoo 行情及明确标记的离线搜索 |
| `netlify/functions/` | API 函数和每日结算函数 |
| `server.mjs` | 本地开发服务器 |
| `scripts/check.mjs` | 语法、版本和静态资源检查 |
| `tests/` | 按功能命名的自动化回归测试 |
| `.github/workflows/ci.yml` | 提交与 PR 时自动检查 |

## 测试

```bash
npm run verify   # check + 全部测试
```

V2.1 的代码基线在 GitHub Actions 上运行 **322 项测试（320 通过、0 失败、2 项真实数据库测试跳过）**，另做 9,600 步非股票资金模拟，现金、预留、借款和流水对账全部通过。检查结果见 [docs/ACCEPTANCE.md](docs/ACCEPTANCE.md)。

## 文档

| 想了解 | 看这里 |
|---|---|
| 每版改动 | [CHANGELOG.md](CHANGELOG.md) |
| Netlify 部署 | [docs/NETLIFY.md](docs/NETLIFY.md) |
| 运维、备份、升级 | [docs/OPERATIONS.md](docs/OPERATIONS.md) |
| 验收结果 | [docs/ACCEPTANCE.md](docs/ACCEPTANCE.md) |

## 边界与说明

- 本项目是家庭账本与投资学习工具，不执行真实银行转账或券商交易
- Yahoo 为非官方行情来源；分红、拆合股、退市等公司行动尚未自动处理
- 金额、日期和交易日历均以香港时间为准
