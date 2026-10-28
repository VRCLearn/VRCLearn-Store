const methods: Readonly<Record<string, "GET" | "POST">> = {
    "/api/auth/sign-up/email": "POST",
    "/api/auth/sign-in/email": "POST",
    "/api/auth/get-session": "GET",
    "/api/auth/list-sessions": "GET",
    "/api/auth/sign-out": "POST",
    "/api/auth/revoke-session": "POST",
    "/api/auth/revoke-sessions": "POST",
    "/api/auth/revoke-other-sessions": "POST",
    "/api/auth/change-password": "POST",
    "/api/auth/update-user": "POST",
};

export function authRouteMethod(path: string): "GET" | "POST" | undefined {
    return Object.hasOwn(methods, path) ? methods[path] : undefined;
}
