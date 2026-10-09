import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, resolve } from "node:path";
import { apiLevelMismatchMessage, unauthorizedMessage, unreachableMessage } from "./messages.js";
import { mimeTypeFor } from "./mime.js";
/** The upload contract this bridge speaks. The app answers 409 when it no longer matches. */
export const API_LEVEL = 1;
export const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;
export const LOCAL_TOOL_NAME = "add_attachment_from_path";
export const localTool = {
    name: LOCAL_TOOL_NAME,
    title: "Attach a file from this computer",
    description: "Attach a file that is on this computer to a TripEZGo trip or event (up to 50 MB). " +
        "The file is read here and uploaded to the app. Without eventId the file is attached to the trip " +
        "itself; without tripId the app's default trip is used. Prefer this over add_attachment for any file on disk.",
    inputSchema: {
        type: "object",
        properties: {
            path: {
                type: "string",
                description: "Path of the file on this computer. Absolute, ~/…, or relative to the bridge's working directory.",
            },
            tripId: { type: "string", description: "Trip id from list_trips. Defaults to the app's default trip." },
            eventId: { type: "string", description: "Event id from list_events. Omit to attach to the trip." },
            name: { type: "string", description: "File name to show in the app. Defaults to the file's own name." },
        },
        required: ["path"],
    },
};
export async function addAttachmentFromPath(args, options) {
    const input = (args && typeof args === "object" ? args : {});
    const rawPath = input.path;
    if (typeof rawPath !== "string" || rawPath.trim() === "") {
        return failure("`path` is required: the path of the file on this computer.");
    }
    const filePath = expandPath(rawPath.trim());
    let size;
    try {
        const info = await stat(filePath);
        if (!info.isFile())
            return failure(`${filePath} is not a file.`);
        size = info.size;
    }
    catch (error) {
        if (isErrno(error, "ENOENT"))
            return failure(`No file at ${filePath}.`);
        return failure(`Can't read ${filePath}: ${error.message}`);
    }
    if (size > MAX_UPLOAD_BYTES) {
        return failure(`${filePath} is ${formatMB(size)}; TripEZGo attachments are limited to ${formatMB(MAX_UPLOAD_BYTES)}.`);
    }
    let bytes;
    try {
        bytes = await readFile(filePath);
    }
    catch (error) {
        return failure(`Can't read ${filePath}: ${error.message}`);
    }
    const name = typeof input.name === "string" && input.name.trim() !== "" ? input.name.trim() : basename(filePath);
    const query = new URLSearchParams();
    if (typeof input.tripId === "string" && input.tripId !== "")
        query.set("tripId", input.tripId);
    if (typeof input.eventId === "string" && input.eventId !== "")
        query.set("eventId", input.eventId);
    query.set("name", name);
    const doFetch = options.fetch ?? fetch;
    let response;
    try {
        response = await doFetch(`${options.baseUrl}/upload?${query.toString()}`, {
            method: "POST",
            headers: {
                Authorization: `Bearer ${options.token}`,
                "X-TripEZGo-Api-Level": String(API_LEVEL),
                "Content-Type": mimeTypeFor(filePath),
            },
            body: bytes,
            signal: AbortSignal.timeout(options.timeoutMs ?? 300_000),
        });
    }
    catch (error) {
        return failure(unreachableMessage(options.baseUrl, error));
    }
    const text = await response.text();
    const json = parseObject(text);
    if (response.status === 409)
        return failure(apiLevelMismatchMessage(errorText(json)));
    if (response.status === 401)
        return failure(unauthorizedMessage());
    if (!response.ok) {
        return failure(`The TripEZGo app refused the upload (HTTP ${response.status}): ${errorText(json) ?? (text.trim() || "no details")}`);
    }
    const attachmentId = json?.attachmentId;
    const shownName = typeof json?.name === "string" ? json.name : name;
    const byteCount = typeof json?.byteCount === "number" ? json.byteCount : size;
    return {
        content: [
            {
                type: "text",
                text: `Attached "${shownName}" (${byteCount} bytes) as attachment ${String(attachmentId)}.\n${text.trim()}`,
            },
        ],
        ...(json ? { structuredContent: json } : {}),
    };
}
function failure(message) {
    return { content: [{ type: "text", text: message }], isError: true };
}
function expandPath(path) {
    if (path === "~")
        return homedir();
    if (path.startsWith("~/"))
        return resolve(homedir(), path.slice(2));
    return resolve(path);
}
function isErrno(error, code) {
    return !!error && typeof error === "object" && error.code === code;
}
function formatMB(bytes) {
    return `${(bytes / (1024 * 1024)).toFixed(1).replace(/\.0$/, "")} MB`;
}
function parseObject(text) {
    try {
        const value = JSON.parse(text);
        return value && typeof value === "object" && !Array.isArray(value) ? value : undefined;
    }
    catch {
        return undefined;
    }
}
function errorText(json) {
    return typeof json?.error === "string" ? json.error : undefined;
}
