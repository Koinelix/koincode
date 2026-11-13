import type { NodeReplRunResult } from "@fcode/core/repl";
import type { CallToolResult } from "@modelcontextprotocol/server";
/** Preserve authenticated Browser occurrences even when structured CUA pixels are identical. */
export declare function buildWindowsCuaResultContent(run: NodeReplRunResult, structuredContent: CallToolResult["content"], suffix: CallToolResult["content"]): {
    content: ({
        type: "text";
        text: string;
        annotations?: {
            audience?: ("user" | "assistant")[] | undefined;
            priority?: number | undefined;
            lastModified?: string | undefined;
        } | undefined;
        _meta?: {
            [x: string]: unknown;
        } | undefined;
    } | {
        type: "image";
        data: string;
        mimeType: string;
        annotations?: {
            audience?: ("user" | "assistant")[] | undefined;
            priority?: number | undefined;
            lastModified?: string | undefined;
        } | undefined;
        _meta?: {
            [x: string]: unknown;
        } | undefined;
    } | {
        type: "audio";
        data: string;
        mimeType: string;
        annotations?: {
            audience?: ("user" | "assistant")[] | undefined;
            priority?: number | undefined;
            lastModified?: string | undefined;
        } | undefined;
        _meta?: {
            [x: string]: unknown;
        } | undefined;
    } | {
        uri: string;
        name: string;
        type: "resource_link";
        description?: string | undefined;
        mimeType?: string | undefined;
        size?: number | undefined;
        annotations?: {
            audience?: ("user" | "assistant")[] | undefined;
            priority?: number | undefined;
            lastModified?: string | undefined;
        } | undefined;
        _meta?: {
            [x: string]: unknown;
        } | undefined;
        icons?: {
            src: string;
            mimeType?: string | undefined;
            sizes?: string[] | undefined;
            theme?: "light" | "dark" | undefined;
        }[] | undefined;
        title?: string | undefined;
    } | {
        type: "resource";
        resource: {
            uri: string;
            text: string;
            mimeType?: string | undefined;
            _meta?: {
                [x: string]: unknown;
            } | undefined;
        } | {
            uri: string;
            blob: string;
            mimeType?: string | undefined;
            _meta?: {
                [x: string]: unknown;
            } | undefined;
        };
        annotations?: {
            audience?: ("user" | "assistant")[] | undefined;
            priority?: number | undefined;
            lastModified?: string | undefined;
        } | undefined;
        _meta?: {
            [x: string]: unknown;
        } | undefined;
    })[];
    captureIndices: number[];
    browserIndices: number[];
};
/** Drop superseded Windows captures before transfer, retaining other media and text. */
export declare function projectWindowsCuaScreenshotWindow<T extends {
    type: string;
    data?: unknown;
    mimeType?: unknown;
    text?: unknown;
}>(content: T[], captures: NodeReplRunResult["cuaCaptures"], browserIndices?: number[]): {
    content: T[];
    captureIndices: number[];
    browserIndices: number[];
};
//# sourceMappingURL=windows-capture-window.d.ts.map