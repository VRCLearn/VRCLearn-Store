export type ControlEnv = ControlBindings & {
    ALERT_EMAIL: string;
    CF_MONITOR_TOKEN?: string;
    CF_API_TOKEN?: string;
};
