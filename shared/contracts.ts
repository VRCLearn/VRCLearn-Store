export type Region = "cn" | "intl";
export type Locale = "en" | "zh-CN" | "ja";
export type Category = "avatars" | "clothing" | "worlds" | "plugins" | "tools" | "services";
export const PLATFORMS = ["pc", "android", "ios"] as const;
export type Platform = typeof PLATFORMS[number];
export const PLATFORM_LABELS: Record<Platform, string> = { pc: "PC", android: "Android", ios: "iOS" };
export interface SessionUser {
    id: string;
    email: string;
    // Better Auth's name field is the public display name, not a username or login identifier.
    name: string;
    role: "user" | "admin";
    banned: boolean;
}
export interface ProductInput {
    title: string;
    language: Locale;
    summary: string;
    description: string;
    category: Category;
    tags: string[];
    compatibleModels: string[];
    platforms: Platform[];
    pricing: "free" | "paid";
    price: number | null;
    currency: string | null;
    purchaseUrl: string;
    mediaIds: string[];
    r18: boolean;
}
export interface Product extends ProductInput {
    id: string;
    shopId: string;
    shopName: string;
    images: string[];
    updatedAt: string;
}
export interface ShopInput {
    name: string;
    description: string;
    websiteUrl: string;
}
export interface Shop extends ShopInput {
    id: string;
}
export interface PageResult<T> {
    items: T[];
    nextCursor: string | null;
}
export interface ApiFailure {
    error: { code: string; message: string; requestId: string };
}
export interface Permission {
    region: Region;
    status: "pending" | "approved" | "rejected" | "revoked";
    reason: string;
}
export interface MerchantProduct {
    id: string;
    content: ProductInput;
    revisionId: string;
    status: "draft" | "pending" | "rejected" | "published" | "withdrawn";
    publishedRegions: Region[];
    requestedRegions: Region[];
    regionalReviews: { region: Region; status: "pending" | "approved" | "rejected"; reason: string }[];
    reviewReason?: string;
}
export interface Workspace {
    shop: Shop | null;
    permissions: Permission[];
    products: MerchantProduct[];
}
export const CATEGORIES: Category[] = ["avatars", "clothing", "worlds", "plugins", "tools", "services"];
export const LOCALES: Locale[] = ["en", "zh-CN", "ja"];

export interface RedemptionInventory {
    total: number;
    available: number;
    redeemed: number;
}

export interface Redemption {
    id: string;
    productId: string;
    title: string;
    content: string;
    redeemedAt: string;
}

export interface ProductComment {
    id: string;
    productId: string;
    authorName: string;
    body: string;
    createdAt: string;
    updatedAt: string;
    verifiedRedemption: true;
}

export interface CommentingInfo {
    eligible: boolean;
    comment: ProductComment | null;
    hidden: boolean;
}
