import queryString from "query-string";

import metadata from "@/metadata.json";
import { injectToContent } from "@utils/polyfill/extension/inject";

import {
    CustomRequestInit,
    CustomRequestMethod,
    CustomRequestResponse,
    GM_xmlhttpResponse,
    RequestMessagePayload,
} from "./types";
import logger from "../../logger";

/**
 * 如果url以/开头，则自动拼接BASE_URL，比如 /query => [apiServer]/[platform]/xxx
 *
 * 不然，则直接使用url，比如 https://www.baidu.com => https://www.baidu.com
 */
export function getFullUrl(url: string, query: any = {}) {
    for (const [, value] of Object.entries(query)) {
        if (typeof value === "object")
            throw new Error("query params不应为嵌套对象，拍平或者手动序列化子对象");
    }

    return queryString.stringifyUrl({
        url: url.startsWith("/")
            ? `${metadata.apiServer}/${process.env.COMPILE_PLATFORM}${url}`
            : url,
        query: query,
    });
}

/**对crx sendMessage的封装，以实现一致的fetch风格的request通用接口 */
export async function requestForExtension<T = any>(
    url: string,
    {
        method,
        headers = {},
        query,
        body /* = {} */, // 允许undefined，JSON.stringify(undefined)也不会报错
    }: CustomRequestInit & { method: CustomRequestMethod } = {
        method: "GET",
        headers: {},
        body: undefined,
        query: undefined,
    },
): Promise<CustomRequestResponse<T>> {
    return new Promise(async (resolve, reject) => {
        injectToContent<RequestMessagePayload>(
            "request",
            {
                url: getFullUrl(url, query),
                init: {
                    method,
                    headers: {
                        "Content-Type": "application/json;charset=UTF-8",
                        ...headers,
                    },
                    body: JSON.stringify(body),
                },
            },
            async (extensionMessage) => {
                const {
                    payload: { text, ok },
                } = extensionMessage;

                if (ok) {
                    resolve({
                        text: () => new Promise<string>((resolve) => resolve(text)),
                        json: () => new Promise<any>((resolve) => resolve(JSON.parse(text))),
                    });
                } else {
                    reject(extensionMessage);
                }
            },
        );
    });
}

// 避免在浏览器环境(非脚本管理器)下报错
// typeof GM_xmlhttpRequest === "function" || function GM_xmlhttpRequest() {};
let hasInitializeXhr = false;
let GM_xmlhttpRequest: any;

async function initializeXhr() {
    if (process.env.CRX) {
        GM_xmlhttpRequest = (options: any) => {
            logger.debug("should not invoke placeholder function GM_xmlhttpRequest");
        };
    } else {
        GM_xmlhttpRequest = await import("$").then((module) => module.GM_xmlhttpRequest);
    }
}

// 不想在requestForUserscript里面再套一层Promise，所以在这里初始化
// 因为并不像setValue和getValue那样一启动app就会调用，这里稍微有点不一致性也没关系
// 可以保证用得上request的时候，已经初始化完毕了
// (async () => {
//     if (!hasInitializeXhr) {
//         await initializeXhr();
//         hasInitializeXhr = true;
//     }
// })();

/**对GM_xmlhttpRequest的封装，以实现一致的fetch风格的request通用接口 */
export function requestForUserscript<T = any>(
    url: string,
    { method, headers={}, query, body }: CustomRequestInit & { method: CustomRequestMethod } = {
        method: "GET",
        headers: {},
        body: undefined,
        query: undefined,
    },
) {
    // promise的executor本身，可以是异步的，所以这里不用套一层Promise
    // https://eslint.org/docs/latest/rules/no-async-promise-executor
    // 文档说捕获不到错误，但是实测，可以捕获到
    return new Promise<CustomRequestResponse<T>>(async (resolve, reject) => {
        if (!hasInitializeXhr) {
            await initializeXhr();
            hasInitializeXhr = true;
        }

        // throw new Error("GM_xmlhttpRequest is xxxxxxxxxx");

        GM_xmlhttpRequest({
            url: getFullUrl(url, query),
            method: method as any,
            // GM_xmlhttpRequest需要手动设置Content-Type，不然默认是text/plain，后端无法识别
            headers: {
                "Content-Type": "application/json;charset=UTF-8",
                ...headers,
            },
            data: typeof body === "object" ? JSON.stringify(body) : body,
            timeout: 5000,
            responseType: "json",
            // @ts-ignore
            onload(response: GM_xmlhttpResponse) {
                const { status: statusCode } = response;
                if (statusCode >= 200 && statusCode <= 300) {
                    resolve({
                        text: () =>
                            new Promise<string>((resolve) => resolve(response.responseText)),
                        json: () => new Promise((resolve) => resolve(response.response as any)),
                    });
                } else {
                    reject(response);
                }
            },
            // @ts-ignore
            onabort: (response: GM_xmlhttpResponse) => reject(response),
            // @ts-ignore
            onerror: (response: GM_xmlhttpResponse) => reject(response),
            // @ts-ignore
            ontimeout: (response: GM_xmlhttpResponse) => reject(response),
        });
    });
}

export default process.env.CRX ? requestForExtension : requestForUserscript;
