export type Region = "cn" | "intl";
export type Locale = "en" | "zh-CN" | "ja";
export type Category = "avatars" | "clothing" | "worlds" | "plugins" | "tools" | "services";
export interface SessionUser {
    id: string;
    email: string;
    name: string;
    emailVerified: boolean;
    role: "user" | "admin";
    banned: boolean;
    twoFactorEnabled: boolean;
    twoFactorVerified: boolean;
}
export interface ProductInput {
    title: string;
    language: Locale;
    summary: string;
    description: string;
    category: Category;
    tags: string[];
    compatibleModels: string[];
    platforms: ("pc" | "android")[];
    pricing: "free" | "paid";
    price: number | null;
    currency: string | null;
    purchaseUrl: string;
    mediaIds: string[];
    r18: false;
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
    reviewReason?: string;
}
export interface Workspace {
    shop: Shop | null;
    permissions: Permission[];
    products: MerchantProduct[];
}
export const CATEGORIES: Category[] = ["avatars", "clothing", "worlds", "plugins", "tools", "services"];
export const LOCALES: Locale[] = ["en", "zh-CN", "ja"];
