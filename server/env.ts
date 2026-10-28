export type AppEnv = AppBindings & {
    ASSETS: Fetcher;
    TURNSTILE_SECRET_KEY: string;
};
