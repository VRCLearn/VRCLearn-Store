export async function readBounded(request: Pick<Request, "headers" | "body">, maxBytes: number): Promise<string | null> {
    if (Number(request.headers.get("content-length") ?? 0) > maxBytes) return null;
    if (!request.body) return "";
    const reader = request.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    while (true) {
        const part = await reader.read();
        if (part.done) break;
        total += part.value.byteLength;
        if (total > maxBytes) { await reader.cancel(); return null; }
        chunks.push(part.value);
    }
    const all = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) { all.set(chunk, offset); offset += chunk.byteLength; }
    try { return new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(all); } catch { return null; }
}

export function failure(code: string, message: string, status: number, retryAfter?: number): Response {
    return Response.json({ error: { code, message, requestId: crypto.randomUUID() } }, {
        status,
        headers: { "Cache-Control": "no-store", ...(retryAfter ? { "Retry-After": String(retryAfter) } : {}) },
    });
}

export async function digestKey(input: string): Promise<string> {
    const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
    return Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
