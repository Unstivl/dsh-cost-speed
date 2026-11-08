# dsh-cost-speed

DeepSeek Harness 的本地计费与速度面板。停靠条贴在输入框上方，默认显示今日估算费用；悬浮展开时、日、周、月四张图。流式生成时同时显示 TPS、首字延迟和上下文占用。

## 功能

- 按真实 DeepSeek BPE 分词估算 token，并按价目表折算金额。
- 四个视图：小时（分钟折线）、日（24 根柱）、周（周一到周日）、月（日历热力图）；默认打开日视图。
- 实时读数：生成中的 TPS、首字延迟、上下文占用与缓存命中。
- 价目表可在面板里直接编辑，保存到本机，重启后继续生效。
- 全部数据留在本机，不发任何网络请求。

## 兼容性

- DSH `0.2.1-rc.3` 及以上，`0.3.0` 之前。
- 浏览器半侧注册在 `web` 平台；Desktop 与 Web 两种形态都用同一套 Web 载体。
- 宿主半侧只依赖 Node 内置模块和 DSH 的 `llm/stream` 事件。

## 安装

### 从插件面板

侧栏打开“插件”，点“添加插件”，粘贴仓库地址：

```
https://github.com/Unstivl/dsh-cost-speed
```

确认安装后，插件会出现在“已安装插件”里。安装新组合包默认启用。

### 从命令行

```bash
dsh plugin --profile desktop add github:Unstivl/dsh-cost-speed
```

换成你自己的 profile 名称即可。安装完成后按提示重启，或等待热重载。

### 开关

插件页里打开 `dsh-cost-speed` 卡片，行开关控制宿主半侧与停靠条。关闭后停靠条消失，账本保留；重新打开会继续累计。开关状态写在 profile 的 `cordis.patch.yml` 里，跨会话生效。

## 价格

默认价目只是示例，采用 DeepSeek 官方 API 的空闲价：

| 模型 | 输入 | 输出 | 缓存命中 |
| --- | --- | --- | --- |
| deepseek-flash | 1 | 4 | 0.02 |
| deepseek-v4-flash | 1 | 4 | 0.02 |
| deepseek-v4-flash-vision-exp | 1 | 4 | 0.02 |
| deepseek-v4-pro | 4.5 | 13.5 | 0.15 |

单位是元 / 百万 tokens。高峰时段（北京时间周一至周五 9:00-12:00、14:00-18:00）按两倍计算。其他服务商与模型需要自己补规则；没有匹配到的模型只统计 token，金额记为未计价，不会静默按零计算。

规则写在 `~/.dsh/cost-monitor/pricing.json`，也可以在停靠卡片里编辑。结构如下：

```json
{
  "note": "说明文字",
  "rules": [
    { "provider": "deepseek-official", "model": "deepseek-flash",
      "price": { "input": 1, "output": 4, "cacheRead": 0.02, "cacheWrite": 4 },
      "peak": { "multiplier": 2, "windows": [[9, 12], [14, 18]], "weekdaysOnly": true, "timezoneOffsetMinutes": 480 } },
    { "provider": "*", "model": "*", "price": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 } }
  ]
}
```

`provider` 与 `model` 支持 `*` 通配。`free: true` 表示这条线路有意按零计价（订阅制或自建模型），与“没有价格”区分开。最后一条 `*/*` 是兜底规则，至少保留一条。

## 数据与隐私

数据目录是 `~/.dsh/cost-monitor/`：

| 文件 | 内容 |
| --- | --- |
| `ledger.json` | 每次调用的一分钟账本，保留 400 天，最多 20 万条 |
| `pricing.json` | 价目表与说明 |
| `history-bill.json` | 从服务商账单导入的小时汇总（可选） |

启动时会读取本机会话日志补齐历史，只取 token 计数、模型名和来源，不保存对话正文。账本里没有提示词、回复或密钥。插件不发任何出站请求。

## 安全

- 插件在本机 HTTP 服务上注册读接口，浏览器半侧只访问同源路径。
- `/config` 与 `/import` 只接受 `POST` 与 `application/json`；所有接口校验 `Origin` / `Host` 与 `Sec-Fetch-Site`，挡住跨站请求与 DNS 重绑定。
- 写入采用临时文件加改名；文件权限按 `0600` 创建（Windows 上以用户目录权限为主）。
- 没有 `postinstall`，没有运行时 npm 依赖，安装前可以完整读完 `lib/`。
- 宿主插件在 DSH 进程内运行，拥有该进程的 Node 权限。安装第三方插件前请先读代码。

发现安全问题请按 [SECURITY.md](SECURITY.md) 的方式报告。

## 开发

```
lib/index.js          宿主半侧：捕获调用、计价、聚合、HTTP 接口
lib/client.js         浏览器半侧：停靠条、四视图卡片、价目编辑
lib/tokenizer/        DeepSeek BPE 分词与增量解码（移植自 dsh-live-token-stats）
cordis.patch.yml      组合包层：插入 id 为 cost-speed 的宿主行
smoke/check.mjs       零依赖冒烟测试
```

没有构建步骤，直接改 `lib/` 里的 JavaScript。验证：

```bash
node smoke/check.mjs
```

仓库里不要放 `ledger.json`、`history-bill.json` 或任何真实账单导出。

## 已知限制

- 金额是估算值，按上报的 token 计数与本地价目计算，与最终账单可能有差异。
- 货币符号固定为人民币元；其他币种只能改价目数值，符号不会跟着变。
- 只支持 Web 平台。
- Windows 上 POSIX 文件权限位基本无效，隔离依赖用户目录的 ACL。

## 许可

MIT。分词器部分的第三方许可见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。