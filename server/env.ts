export type AppEnv = PagesBindings & {
    ASSETS: Fetcher;
    TURNSTILE_SECRET_KEY: string;
};
