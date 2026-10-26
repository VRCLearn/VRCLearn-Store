import { marked } from "marked";

export function escapeHtml(value: string): string {
    return value.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[character] ?? character));
}

export function safeMarkdown(source: string): string {
    const renderer = new marked.Renderer();
    renderer.html = ({ text }) => escapeHtml(text);
    renderer.link = ({ href, text }) => {
        try {
            const url = new URL(href);
            if (url.protocol !== "https:" || url.username || url.password) return escapeHtml(text);
            return `<a href="${escapeHtml(url.href)}" rel="nofollow noopener noreferrer" target="_blank">${escapeHtml(text)}</a>`;
        } catch {
            return escapeHtml(text);
        }
    };
    // Uploaded, reviewed images are rendered by the product template only.
    renderer.image = ({ text }) => escapeHtml(text);
    return marked.parse(source, { renderer, async: false });
}

export function safeJson(value: unknown): string {
    return JSON.stringify(value).replace(/</g, "\\u003c").replace(/>/g, "\\u003e").replace(/&/g, "\\u0026").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
}
