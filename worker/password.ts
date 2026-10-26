import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";

// OWASP's N=2^15, r=8, p=3 profile fits a Worker's memory limit.
// The format is explicit so parameters cannot silently drift with a dependency.
const PARAMETERS = { N: 32_768, r: 8, p: 3, maxmem: 64 * 1024 * 1024 };

function derive(password: string, salt: string): Promise<Buffer> {
    return new Promise((resolve, reject) => {
        scrypt(password.normalize("NFKC"), salt, 64, PARAMETERS, (error, key) => {
            if (error) reject(error);
            else resolve(key);
        });
    });
}

export async function hashPassword(password: string): Promise<string> {
    const salt = randomBytes(16).toString("hex");
    const key = await derive(password, salt);
    return `scrypt$32768$8$3$${salt}$${key.toString("hex")}`;
}

export async function verifyPassword(input: { hash: string; password: string }): Promise<boolean> {
    const parts = /^scrypt\$32768\$8\$3\$([a-f0-9]{32})\$([a-f0-9]{128})$/.exec(input.hash);
    if (!parts) return false;
    const key = await derive(input.password, parts[1]);
    return timingSafeEqual(key, Buffer.from(parts[2], "hex"));
}
