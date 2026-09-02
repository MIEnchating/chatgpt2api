import type { AxiosError, AxiosRequestConfig } from "axios";

import {extractRequestErrorMessage} from "@/lib/request-error";

type RequestConfig = AxiosRequestConfig & {
    redirectOnUnauthorized?: boolean;
};

type ErrorPayload = {
    detail?: string | { error?: string | { message?: string } };
    error?: string | { message?: string; code?: string; type?: string };
    message?: string;
};

type AppRequestError = Error & {
    status?: number;
    code?: string;
    errorType?: string;
    payload?: unknown;
};

export type UnauthorizedRedirectEnvironment = {
    pathname: string;
    clearImageCache: () => void;
    replace: (path: string) => void;
};

function errorCodeFromValue(value: unknown): string {
    if (!value || typeof value !== "object") {
        return "";
    }
    const item = value as { code?: unknown; type?: unknown; error?: unknown; message?: unknown };
    if (typeof item.code === "string" && item.code.trim()) {
        return item.code.trim();
    }
    if (typeof item.type === "string" && item.type.trim()) {
        return item.type.trim();
    }
    return errorCodeFromValue(item.error);
}

export function rejectRequestError(
    error: AxiosError<ErrorPayload>,
    redirectEnvironment?: UnauthorizedRedirectEnvironment,
): Promise<never> {
    const status = error.response?.status;
    const shouldRedirect = (error.config as RequestConfig | undefined)?.redirectOnUnauthorized !== false;
    if (status === 401 && shouldRedirect && redirectEnvironment && !redirectEnvironment.pathname.startsWith("/login")) {
        redirectEnvironment.clearImageCache();
        redirectEnvironment.replace("/login");
    }

    const payload = error.response?.data;
    const code =
        errorCodeFromValue(payload?.detail) ||
        errorCodeFromValue(payload?.error) ||
        "";
    const errorValue = payload?.error;
    const errorType =
        errorValue && typeof errorValue === "object" && typeof (errorValue as { type?: unknown }).type === "string"
            ? String((errorValue as { type?: unknown }).type || "")
            : "";
    const message =
        extractRequestErrorMessage(payload?.detail) ||
        extractRequestErrorMessage(payload?.error) ||
        extractRequestErrorMessage(payload?.message) ||
        error.message ||
        `请求失败 (${status || 500})`;
    const appError = new Error(message) as AppRequestError;
    appError.status = status;
    appError.code = code || undefined;
    appError.errorType = errorType || undefined;
    appError.payload = payload;
    return Promise.reject(appError);
}
