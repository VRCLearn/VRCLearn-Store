import type { ApiFailure } from "../shared/contracts";
import type { MessageKey } from "./i18n";

export class ApiError extends Error {
    constructor(message: string, public status: number, public code: string, public requestId?: string) {
        super(message);
    }
}

export function localizedError(error: unknown, t: Record<MessageKey, string>): string {
    if (!(error instanceof ApiError)) return error instanceof Error ? error.message : t.error;
    const keys: Record<string, MessageKey> = {
        SIGN_IN_REQUIRED: "signInRequired", UNAUTHORIZED: "signInRequired", SESSION_EXPIRED: "sessionExpired",
        INVALID_EMAIL_OR_PASSWORD: "invalidCredentials",
        INVALID_PASSWORD: "invalidCredentials", USER_ALREADY_EXISTS: "emailAlreadyUsed",
        USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL: "emailAlreadyUsed",
        ADMIN_REQUIRED: "adminRequired", ACCOUNT_RESTRICTED: "accountRestricted",
        REGION_UNKNOWN: "regionUnavailable", CLIENT_UNVERIFIED: "regionUnavailable",
        PRODUCT_NOT_FOUND: "unavailable", SHOP_NOT_FOUND: "shopUnavailable",
        INVALID_QUERY: "searchHint", CURRENCY_REQUIRED: "priceHint", INVALID_FILTER: "invalidFilters",
        INVALID_SORT: "invalidFilters", INVALID_CURSOR: "refreshRequired", INVALID_INPUT: "checkFields",
        INVALID_IMAGE: "uploadHint", BODY_TOO_LARGE: "uploadHint", PAYLOAD_TOO_LARGE: "checkFields",
        QUOTA_EXCEEDED: "tooManyRequests", RATE_LIMITED: "tooManyRequests", STORAGE_QUOTA_EXCEEDED: "actionUnavailable",
        REVISION_STORAGE_QUOTA_EXCEEDED: "actionUnavailable",
        DUPLICATE_OPERATION: "duplicateAction", REVISION_CONFLICT: "refreshRequired", REVIEW_CONFLICT: "refreshRequired",
        REGION_PERMISSION_REQUIRED: "permissionRequired", SHOP_REVIEW_REQUIRED: "shopApprovalRequired",
        ALL_REGIONS_REQUIRED: "allRegionsRequired", WITHDRAW_REQUIRED: "pendingImmutable", REVISION_REQUIRED: "saveBeforeSubmit",
        ADULT_CN_FORBIDDEN: "adultRegionHint",
        CODE_UNAVAILABLE: "codeUnavailable", CODE_IMPORT_CONFLICT: "codeImportConflict",
        COMMENT_NOT_FOUND: "commentUnavailable", COMMENT_UNAVAILABLE: "commentUnavailable", COMMENT_REPORT_UNAVAILABLE: "commentUnavailable",
        VERIFICATION_REQUIRED: "turnstileWait", VERIFICATION_FAILED: "verificationExpired", CHALLENGE_FAILED: "verificationExpired",
        AUTH_UNAVAILABLE: "noApi", SERVICE_UNAVAILABLE: "noApi", NETWORK_UNAVAILABLE: "networkUnavailable",
    };
    const key = keys[error.code];
    return key ? t[key] : error.status >= 500 ? t.noApi : error.status === 429 ? t.tooManyRequests : t.error;
}

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
    const headers = new Headers(init.headers);
    if (init.body && typeof init.body === "string") headers.set("Content-Type", "application/json");
    let response: Response;
    try {
        response = await fetch(`/api/v1${path}`, { ...init, headers, credentials: "same-origin" });
    } catch (error) {
        if (error instanceof Error && error.name === "AbortError") throw error;
        throw new ApiError("Network unavailable", 503, "NETWORK_UNAVAILABLE");
    }
    const contentType = response.headers.get("Content-Type") ?? "";
    if (!contentType.includes("application/json")) throw new ApiError("Service unavailable", response.ok ? 503 : response.status, "SERVICE_UNAVAILABLE");
    let data: unknown;
    try { data = await response.json(); }
    catch { throw new ApiError("Service unavailable", 502, "SERVICE_UNAVAILABLE"); }
    if (!response.ok) {
        const failure = data as Partial<ApiFailure>;
        throw new ApiError(failure.error?.message ?? "Request failed", response.status, failure.error?.code ?? "REQUEST_FAILED", failure.error?.requestId);
    }
    return data as T;
}

export function send<T>(path: string, method: string, body?: unknown, signal?: AbortSignal): Promise<T> {
    return api<T>(path, { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal });
}
