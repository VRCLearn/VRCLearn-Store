import type { SupportEnv } from "./env";
import { digestKey } from "./http";
import { validQuotaResponse, type QuotaLimit, type QuotaResult } from "./quota-core";
import { serviceEnabled } from "../edge/budget";

export async function reserve(env: Pick<SupportEnv, "QUOTA">, key: string, limits: QuotaLimit[]): Promise<QuotaResult> {
    const result = await env.QUOTA.getByName("global").fetch(new Request("https://quota.internal/reserve", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ key, limits }),
    }));
    if (result.status !== 200 && result.status !== 429) throw new Error("QUOTA_UNAVAILABLE");
    const value: unknown = await result.json();
    if (!validQuotaResponse(value, result.status)) throw new Error("QUOTA_UNAVAILABLE");
    return value;
}

export async function accountEmailsEnabled(env: SupportEnv): Promise<boolean> {
    return serviceEnabled(env, true);
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
    const testing = env.DEPLOYMENT_ENV === "test";
    const title = testing ? `[TEST] ${subject}` : subject;
    await env.EMAIL.send({
        from: { email: env.EMAIL_FROM, name: testing ? "VRCLearn Store Test" : "VRCLearn Store" },
        to,
        subject: title,
        text: `${title}\n\n${target.href}\n\nIf you did not request this email, you can ignore it.`,
        html: `<p>${title}</p><p><a href="${escaped}">Continue to VRCLearn Store</a></p><p>If you did not request this email, you can ignore it.</p>`,
    });
}
