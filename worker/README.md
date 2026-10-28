# 内部辅助 Worker

测试辅助 Worker 为 `test-vrclearn-store-support`，仅通过本环境主 Worker 的内部 Service Binding 与 DO 绑定调用。关闭公共路由、`workers.dev` 和版本 URL；CPU 上限 500 ms。生产只有未开通的配置定义，不随测试发布创建资源。

## 基本账户

Better Auth 提供邮箱/密码注册登录、已登录改密码、更新昵称、登出和会话撤销。邮箱不验证所有权，不发送验证或重置邮件，不提供邮件找回密码、MFA 或独立 username。未来接入 Loginflare，本期不做统一登录和自动账户关联。

密码使用原生 `node:crypto.scrypt`，N=32768、r=8、p=3，参数和格式进入存储值；不降低参数或提供弱化回退。会话 Cookie 使用 Secure、HttpOnly、SameSite=Lax，并按主机限定。内部会话查询按稳定账户 ID 加载角色和封禁状态，管理员需显式授予。

只有本测试环境的 `BETTER_AUTH_SECRET` 和 `TURNSTILE_SECRET_KEY`，不绑定 EMAIL、账单、WAF 或部署凭据。认证端点限制路径、HTTP 方法、Origin、请求体、可信客户端地址、Turnstile、认证限流和原子配额；错误保留明确 HTTP 状态和请求编号，不输出秘密。

## 配额

`QUOTA.getByName("global").fetch("https://quota.internal/reserve", ...)` 接收逻辑操作 ID 和同一事务内的一组额度：

```json
{
    "key": "upload:logical-operation-id",
    "limits": [
        { "key": "upload:bytes", "limit": 2097152, "amount": 1024, "windowSeconds": 86400 }
    ]
}
```

首次允许返回 `{"allowed":true}`；不足返回 429 和 `{"allowed":false,"retryAfter":60}`。重复 key 返回 `duplicate:true`，不再次扣除，也不授权第二次昂贵操作。任一额度不足时整组不扣除；`period:"month"` 使用 UTC 日历月。结果不明时不自动退还或重放，长期业务幂等性另由 D1 状态维护。

SQLite 账本总数最多 100,000 条。获准操作最多清理 32 条过期记录，拒绝和重放不触发删除；Alarm 每批最多 1,000 条，有积压时最早 60 秒后继续，空账本停止 Alarm。清理、配额写入和 Alarm 更新同事务提交，失败不放行。

## 清理与发布

Cron `*/15 * * * *` 只执行有界孤立媒体/草稿及过期会话/验证记录清理，不读取账户账单或修改 WAF。验证记录表是 Better Auth 的标准结构，不代表已启用邮箱验证。

Vite 与主 Worker 同一次编译，发布使用 `dist/support/wrangler.json`。先发布并核对辅助 Worker，再发布主 Worker；两者 SHA、资源绑定和活跃版本均须读回一致。未知写入保留发布锁，不自动重复部署。实际配置和验收见 [运维说明](../docs/operations.md)。
