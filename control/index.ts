import type { ControlEnv } from "./env";
import { activateEdgeStops, monitorStopTargets } from "./monitor";
import { failure } from "../worker/http";
export { QuotaGate } from "./quota";

export default {
    async fetch(): Promise<Response> {
        return failure("NOT_FOUND", "Endpoint not found", 404);
    },
    async scheduled(_controller, env, ctx): Promise<void> {
        ctx.waitUntil((async () => {
            await env.QUOTA.getByName("account-monitor").checkBudget();
        })().catch(async () => {
            console.warn(JSON.stringify({ event: "account_budget_check_failed" }));
            // The DO may still be awaiting an uncertain write. Do not run a
            // second KV writer outside its serialization boundary.
            const stopped = await activateEdgeStops(env, monitorStopTargets(env, { production: true, test: true }));
            console.warn(JSON.stringify({ event: "account_monitor_emergency_stop", verified: stopped.verified }));
        }));
    },
} satisfies ExportedHandler<ControlEnv>;
