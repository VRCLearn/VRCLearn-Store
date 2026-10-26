import type { SupportEnv } from "./env";
import { digestKey } from "./http";
import type { QuotaLimit, QuotaResult } from "./quota-core";

export async function reserve(env: SupportEnv, key: string, limits: QuotaLimit[]): Promise<QuotaResult> {
    const result = await env.QUOTA.getByName("global").fetch(new Request("https://quota.internal/reserve", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ key, limits }),
    }));
    if (result.status !== 200 && result.status !== 429) throw new Error("QUOTA_UNAVAILABLE");
    const value: unknown = await result.json();
    if (!value || typeof value !== "object" || !("allowed" in value) || typeof value.allowed !== "boolean") throw new Error("QUOTA_UNAVAILABLE");
    return value as QuotaResult;
}

export async function accountEmailsEnabled(env: SupportEnv): Promise<boolean> {
    if (env.ENVIRONMENT !== "production") return true;
    const budget = await env.STATE.get<{ mode: string; updatedAt: string }>("budget:state", "json");
    const checked = budget ? Date.parse(budget.updatedAt) : NaN;
    return Boolean(budget && budget.mode === "normal" && Number.isFinite(checked) && Date.now() - checked <= 1_800_000 && checked <= Date.now() + 60_000);
}

export async function sendAccountEmail(env: SupportEnv, to: string, subject: string, url: string): Promise<void> {
    if (!await accountEmailsEnabled(env)) throw new Error("EMAIL_PAUSED");
    const recipientKey = await digestKey(to.trim().toLowerCase());
    const allowed = await reserve(env, `mail:${crypto.randomUUID()}`, [
        { key: `mail:recipient:minute:${recipientKey}`, limit: 1, windowSeconds: 60 },
        { key: `mail:recipient:day:${recipientKey}`, limit: 5, windowSeconds: 86400 },
        { key: "mail:global:day", limit: 100, windowSeconds: 86400 },
        { key: "mail:global:month", limit: 2500, windowSeconds: 2_678_400, period: "month" },
    ]);
    if (!allowed.allowed) throw new Error("EMAIL_QUOTA_EXCEEDED");
    const target = new URL(url);
    if (target.origin !== env.ORIGIN) throw new Error("INVALID_EMAIL_LINK");
    const escaped = target.href.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character] ?? character);
    await env.EMAIL.send({
        from: { email: env.EMAIL_FROM, name: "VRCLearn Store" },
        to,
        subject,
        text: `${subject}\n\n${target.href}\n\nIf you did not request this email, you can ignore it.`,
        html: `<p>${subject}</p><p><a href="${escaped}">Continue to VRCLearn Store</a></p><p>If you did not request this email, you can ignore it.</p>`,
    });
}
