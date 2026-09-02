import axios, {type AxiosRequestConfig} from "axios";

import webConfig from "@/constants/common-env";
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
});

request.interceptors.response.use(
    (response) => response,
    (error) => rejectRequestError(error, browserUnauthorizedRedirectEnvironment()),
);

type RequestOptions = {
    method?: string;
    body?: unknown;
    headers?: Record<string, string>;
    redirectOnUnauthorized?: boolean;
    signal?: AbortSignal;
    timeout?: number;
    responseType?: AxiosRequestConfig["responseType"];
    onDownloadProgress?: AxiosRequestConfig["onDownloadProgress"];
};

export async function httpRequest<T>(path: string, options: RequestOptions = {}) {
    const {method = "GET", body, headers, redirectOnUnauthorized = true, signal, timeout, responseType, onDownloadProgress} = options;
    const config: RequestConfig = {
        url: path,
        method,
        data: body,
        headers,
        redirectOnUnauthorized,
        signal,
        timeout,
        responseType,
        onDownloadProgress,
    };
    const response = await request.request<T>(config);
    return response.data;
}
