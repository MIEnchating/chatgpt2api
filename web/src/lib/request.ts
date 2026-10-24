import axios, {type AxiosRequestConfig} from "axios";

import webConfig from "@/constants/common-env";
import {assertServerSentEventContentType, readServerSentEvents} from "@/lib/server-sent-events";
import {clearAuthenticatedImageCache} from "@/lib/authenticated-image";
import {
    rejectRequestError,
    type UnauthorizedRedirectEnvironment,
} from "@/lib/request-response-error";

type RequestConfig = AxiosRequestConfig & {
    redirectOnUnauthorized?: boolean;
};

function browserUnauthorizedRedirectEnvironment(): UnauthorizedRedirectEnvironment | undefined {
    if (typeof window === "undefined") return undefined;
    return {
        pathname: window.location.pathname,
        clearImageCache: clearAuthenticatedImageCache,
        replace: (path) => window.location.replace(path),
    };
}

const request = axios.create({
    baseURL: webConfig.apiUrl.replace(/\/$/, ""),
    withCredentials: true,
    timeout: 30_000,
});

request.interceptors.response.use(
    (response) => response,
    async (error) => {
        if (error.response?.data instanceof ReadableStream) {
            const text = await new Response(error.response.data).text();
            try {
                error.response.data = JSON.parse(text);
            } catch {
                error.response.data = { message: text || error.message };
            }
        }
        return rejectRequestError(error, browserUnauthorizedRedirectEnvironment());
    },
);

type RequestOptions = {
    method?: string;
    body?: unknown;
    headers?: Record<string, string>;
    redirectOnUnauthorized?: boolean;
    signal?: AbortSignal;
    timeout?: number;
    responseType?: AxiosRequestConfig["responseType"];
};

export async function httpRequest<T>(path: string, options: RequestOptions = {}) {
    const {method = "GET", body, headers, redirectOnUnauthorized = true, signal, timeout = 30_000, responseType} = options;
    const config: RequestConfig = {
        url: path,
        method,
        data: body,
        headers,
        redirectOnUnauthorized,
        signal,
        timeout,
        responseType,
    };
    const response = await request.request<T>(config);
    return response.data;
}

export async function httpRequestEventStream(
    path: string,
    options: Omit<RequestOptions, "responseType"> & { onData: (data: string) => void; maxEventCharacters?: number; idleTimeoutMs?: number },
) {
    const config: RequestConfig = {
        url: path,
        method: options.method || "GET",
        data: options.body,
        headers: { ...options.headers, Accept: "text/event-stream" },
        signal: options.signal,
        redirectOnUnauthorized: options.redirectOnUnauthorized ?? true,
        timeout: options.timeout ?? 600_000,
        adapter: "fetch",
        responseType: "stream",
    };
    const response = await request.request<ReadableStream<Uint8Array>>(config);
    try {
        assertServerSentEventContentType(response.headers["content-type"]);
    } catch (error) {
        await response.data.cancel();
        throw error;
    }
    await readServerSentEvents(response.data, options.onData, options);
}
