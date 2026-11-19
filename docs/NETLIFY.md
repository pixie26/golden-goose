# 金鹅银行 V2.0.3：Netlify 上线指南

本项目由静态网页、两个 Netlify Functions 和持久化 PostgreSQL 组成。建议使用 **私人 GitHub 仓库 + Netlify + Supabase PostgreSQL**。正式包已经包含所需配置，没有要求你再改前端代码。

## 一、先确认目录层级

解压 ZIP，进入 `royal-golden-goose/`。这个目录应直接包含 `package.json`、`package-lock.json`、`netlify.toml`、`public/`、`lib/` 和 `netlify/`。

把这个目录的内容放在仓库根目录。若你将整个文件夹嵌套放入仓库，也可以部署，但 Netlify 的 Base directory 必须设为该文件夹；下文默认仓库根目录就是项目根目录。

## 二、建立数据库

1. 在 [Supabase](https://supabase.com/) 创建项目，并保存数据库密码。
2. 打开项目的 **Connect**，选择 **Transaction pooler**，复制完整 PostgreSQL 连接串。请复制后台实际提供的 host，不要按照地区自行拼接。
3. 使用表 owner 连接，通常用户名形如 `postgres.[PROJECT_REF]`，端口一般是 `6543`。这是数据库连接，不是 `anon key` 或前端项目 URL。
4. 生产环境推荐在连接串使用 `?sslmode=verify-full`，并在 Supabase 的 **SSL Configuration** 下载数据库 CA 证书，将证书全文配置为 `DATABASE_CA_CERT`。这样同时校验证书链和主机名。示例中的 host、密码和项目标识均需替换为后台实际提供的值：

   `postgresql://postgres.[PROJECT_REF]:[URL_ENCODED_PASSWORD]@[POOLER_HOST]:6543/postgres?sslmode=verify-full`

   已使用 `sslmode=require` 的部署仍可沿用；它加密连接，但不校验服务端证书身份。`verify-full` 必须配合匹配的可信 CA，不能仅改连接串而遗漏证书。V1.0.1 起项目明确处理这些模式，避免 pg 连接串选项覆盖传入的 TLS 配置。远程数据库在未指定模式时也默认加密；本地不带 TLS 的测试库可显式使用 `sslmode=disable`。
密码若含 `@`、`#`、`:`、`/`、`?` 等特殊字符，需要正确 URL 编码。不要把真实连接串发送到聊天、提交到仓库或写入 `public/`。

应用首次连接会在事务中创建 `bank_state` 表和一条空账本，自动启用 RLS，撤销公开和 Supabase 网页角色的表权限。**DATABASE_URL 的账户需要拥有该表及建表、ALTER 权限；采用上述 owner 连接即可。** 不需要给 `anon` 或 `authenticated` 增加任何 policy；网页只通过自己的 `/api/*` 与账本交互。

Supabase 官方将 transaction pooler 用于短连接的 serverless 场景。本项目 `pg` 每个暖实例最多一个连接，查询没有命名 prepared statement。锁等待和语句超时在每个事务内设置，不依赖会被 transaction pooler 忽略的连接启动参数。[连接方式说明](https://supabase.com/docs/guides/database/connecting-to-postgres) · [RLS 说明](https://supabase.com/docs/guides/database/postgres/row-level-security)。

## 三、上传完整源码到私人 GitHub 仓库

在 GitHub 新建 Private 仓库。可以使用 GitHub Desktop，也可以在项目目录执行：

```bash
git init
git add .
git commit -m "Release Golden Goose Bank v2.0.3"
git branch -M main
```

随后按 GitHub 新仓库页面给出的地址添加远程仓库并推送。不要直接上传 ZIP 文件本身作为仓库里的唯一文件，要上传解压后的源码。

`.gitignore` 已排除 `data/`、备份、`.env`、`node_modules/` 和构建缓存。发布包本身也没有个人账本或测试账户。仓库中的 `docs/` 和 `tests/` 不会作为网页公开，因为 Publish directory 只有 `public/`。

## 四、Netlify 导入

在 [Netlify](https://app.netlify.com/) 添加项目，选择从 GitHub 导入仓库。

| 设置 | 填写 |
|---|---|
| Production branch | `main` |
| Base directory | 留空，前提是源码就在仓库根目录 |
| Build command | `npm run build` |
| Publish directory | `public` |
| Functions directory | `netlify/functions` |
| Node.js | `24`，已写入 `.node-version` 及 `netlify.toml` |

Netlify 应自动读取 `netlify.toml`。网页无需编译框架；build 命令会检查代码语法、版本一致性及资源是否存在，平台随后打包函数。

**不能只把 `public/` 拖进 Netlify Drop。** 这个应用需要完整的函数和数据库服务。使用上述 Git 连接路线即可一起部署。

## 五、配置两个必填环境变量

在项目的 **Environment variables** 中添加：

| 名称 | 内容 |
|---|---|
| `DATABASE_URL` | 第二步复制并配置好 TLS 的 PostgreSQL 连接串 |
| `SETUP_TOKEN` | 自己生成的随机初始化密钥，至少 32 个随机字符 |
| `DATABASE_CA_CERT` | 按推荐的 `verify-full` 配置时填 Supabase CA 证书全文；继续使用 `require` 时可省略，但不校验证书身份 |

若可以选择范围，包含 **Functions**；部署 context 只设为 **Production**。若界面不支持细分范围，至少确保生产值不会供不可信预览分支使用。预览要测试时使用独立测试数据库和独立密钥。

不要把这两个密钥写入 `netlify.toml`；该文件中的 `[build.environment]` 仅用来选择 Node.js。函数运行时变量要通过 Netlify 后台 / CLI / API 配置。[官方环境变量说明](https://docs.netlify.com/build/functions/environment-variables/)。

配置后重新部署，使函数取得新的变量。`SETUP_TOKEN` 在首次开户后仍保留在 Netlify 配置中：当前函数入口会检查它存在，但已开户账本不会允许再次初始化。

## 六、首次验收与开户

1. 等待部署成功，打开 Netlify 给出的 HTTPS 网址。
2. 页面首次设置时，输入自己的 `SETUP_TOKEN`、新的家长密码和 Olivia PIN。家长密码 12–128 位，PIN 为 6–10 位数字。
3. 完成后先用家长登录，再退出并用 Olivia 登录。
4. 如已有真实数据库账本，应直接出现登录页；不要重新建账。
5. 在 Functions 页面确认有 `bank` 和 `daily-settlement` 两个函数。

首次正式入账请使用确实准备为 Olivia 备付的金额，避免把没有删除入口的演示资金写入真实账本。需要完整练习流程时，先连独立测试库，不与生产库混用。

**必须核实的线上项目：** 登录退出、刷新后余额保留、购物审批和退款、借款全部还清、手机端页面、Yahoo 搜索与收盘价日期、手动触发一次定时函数。核对步骤和预期结果见 [ACCEPTANCE.md](ACCEPTANCE.md)。

## 七、自动结算

配置中的 cron 是 `30 9,22 * * *`，以 UTC 计时：

| UTC | 香港时间 | 用途 |
|---|---|---|
| 09:30 | 当日 17:30 | 港股收盘后更新及结算 |
| 22:30 | 次日 06:30 | 美股收盘后更新及结算 |

同时处理到期定存和借款计息。订单优先使用目标交易日已确认收盘价；该日没有收盘价、但之后已有合格收盘价时，自动顺延到之后第一个收盘价，并记录原定日期。如果只是当晚行情迟到、还没有更晚的收盘价，则继续等待。同一证券按规范后的成交日与提交先后处理，不影响其他证券。

Netlify 定时任务只在已发布的部署上自动运行，预览分支不会按计划触发。可在对应函数页面用 **Run now** 检查，并看日志确认结果；这不是访问某个网页链接触发。[官方定时函数说明](https://docs.netlify.com/build/functions/scheduled-functions/)。

Yahoo 返回 403、429 或网络错误时，定存和借款仍需核对正常结算；股票缺少合格价格会保持待成交。家长可核实收盘价后手动登记。Yahoo 接口不是稳定性有保证的授权行情源。

## 八、套餐用量与时间限制

核查日期 2026-11-19，以两家官网当前说明为准：

| 项目 | 免费版要点 | 本应用的对应做法 |
|---|---|---|
| Netlify credits | 每月 300 credits，硬上限；每次成功的正式部署 15 credits，函数运行 10 credits / GB·小时，流量 20 credits / GB，请求 2 credits / 万次。用完后**账号下所有站点暂停**至下个计费周期 | 上线初期尽量合并改动后再部署（20 次正式部署即用完全部额度）；Deploy Preview 的部署本身不扣 credits，但实际请求、流量和函数计算仍计用量。家庭日常使用的函数和流量消耗较小 |
| Netlify 函数时长 | 同步函数 60 秒，定时函数 30 秒 | 应用仍主动将页面中的 Yahoo 工作限制在 7 秒内，以及时回退、保存并答复；定时结算预算不变 |
| Supabase 出站流量 | 免费版每月 5 GB（未缓存），超出后可能受限 | V1.0.3 每次页面刷新约 455 KB；V2.0.0 未变化时约 0.1 KB，主要流量来自写入后的下一次读取 |

Netlify 会在用量达到 50%、75%、100% 时以邮件和站内消息提醒；若不希望因额度用完而暂停，可考虑付费套餐。[Netlify credits 说明](https://docs.netlify.com/manage/accounts-and-billing/billing/billing-for-credit-based-plans/how-credits-work/) · [Netlify 价格](https://www.netlify.com/pricing/) · [Supabase 出站流量](https://supabase.com/docs/guides/platform/manage-your-usage/egress)

### 速度：函数与数据库放在同一地区

每个页面操作都要从香港到函数往返一次，函数再按顺序查询数据库数次，所以数据库应与函数在同一地区。2023 年 10 月 4 日以后新建的 Netlify 站点，函数默认在 Ohio（`cmh`，即 AWS `us-east-2`），Supabase 应选 **East US (Ohio)**。更早的站点请在 Netlify 后台核对函数地区。函数地区只能在 Pro / Enterprise 套餐中更改。

API 自己用 Brotli / gzip 压缩 JSON。部署后可在浏览器开发者工具的 Network 中打开 `/api/state`，响应头应有 `content-encoding: br`（或 `gzip`）。

## 九、常见故障

| 现象 | 优先检查 |
|---|---|
| 首页能开，登录或 `/api/bootstrap` 404 | 是否只上传了 `public/`；项目根目录及 Functions 路径是否正确 |
| 503，提示缺少 DATABASE_URL / SETUP_TOKEN | 是否配置了 Functions 范围和 Production context；设置后是否重新部署 |
| 503，提示账本数据库暂不可用 | 打开 Netlify 的 Functions 日志，找 `[bank-api]` 行里 `cause:` 后面的原因：`SELF_SIGNED_CERT_IN_CHAIN` 表示证书校验不通过（核对 `sslmode`、`DATABASE_CA_CERT` 及证书主机名）；`28P01` 表示密码错误或未 URL 编码；`ENOTFOUND` 表示主机名错误；`Tenant or user not found` 表示用户名不是 `postgres.[PROJECT_REF]` 格式；其他情况检查数据库是否暂停、owner 权限。日志只记录原因，不记录密码，也不会回传给网页 |
| 想继续旧账本却出现首次设置 | 是否换了数据库、项目或本地数据路径；先检查，不重建 |
| Yahoo 搜索出现离线目录提示 | Netlify 到 Yahoo 的实际访问受限；目录不是完整证券池，也没有虚构实时价格 |
| 订单一直待成交 | 目标日是否已收盘一小时、是否有对应日期收盘价、定时任务是否运行；同股较早订单缺价会阻塞晚单。出现历史成本核对提示时，先按 OPERATIONS.md 对账 |
| 更改代码但页面似乎没更新 | 是否部署了正确分支、浏览器刷新；正式版资源缓存号已统一 |
| 整个站点显示暂停或无法访问 | Netlify 后台 Usage 是否已用完当月 credits；Supabase 是否有用量限制通知 |

## 十、升级与数据

后续提交代码会触发新部署；数据库继续使用同一连接时，重新部署不会清空账本。变更数据库或从本地 JSON 搬迁时，需要独立备份和核对；当前没有一键导入功能。

不要把新测试部署连到正式账本，也不要让旧独立站点继续操作同一家庭资金的另一份账本。恢复与回退方法见 [OPERATIONS.md](OPERATIONS.md)。

## 官方参考

- [Netlify Functions 路由、模块格式、运行时](https://docs.netlify.com/build/functions/configuration/)
- [Netlify Node.js 与依赖安装](https://docs.netlify.com/build/configure-builds/manage-dependencies/)
- [Netlify Functions 环境变量](https://docs.netlify.com/build/functions/environment-variables/)
- [Netlify Scheduled Functions](https://docs.netlify.com/build/functions/scheduled-functions/)
- [Supabase PostgreSQL 连接](https://supabase.com/docs/guides/database/connecting-to-postgres)
- [Supabase Row Level Security](https://supabase.com/docs/guides/database/postgres/row-level-security)

核查日期：2026-11-19。本说明不代表你的 Netlify 或 Supabase 账号已经被连接、创建或发布。

- [Supabase SSL 说明（verify-full 需要下载 Supabase CA）](https://supabase.com/docs/guides/platform/ssl-enforcement)
- [node-postgres SSL](https://node-postgres.com/features/ssl)
