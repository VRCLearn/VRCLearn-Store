export type SupportEnv = SupportBindings & {
    BETTER_AUTH_SECRET: string;
    TURNSTILE_SECRET_KEY: string;
    CF_MONITOR_TOKEN?: string;
    CF_API_TOKEN?: string;
};
