import { mkdtemp, rm, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MAX_UPLOAD_BYTES, addAttachmentFromPath } from "../src/upload.js";
import { FakeApp, closedPortUrl, json } from "./fakeApp.js";

const TOKEN = "tok_upload";
const TRIP = "6B1F8F0E-1111-4E1C-9C55-2D7B1A0F0001";
const EVENT = "6B1F8F0E-2222-4E1C-9C55-2D7B1A0F0002";

describe("add_attachment_from_path", () => {
  let app: FakeApp;
  let baseUrl: string;
  let dir: string;

  beforeEach(async () => {
    app = new FakeApp();
    baseUrl = await app.start();
    dir = await mkdtemp(join(tmpdir(), "tripezgo-mcp-test-"));
  });

  afterEach(async () => {
    await app.stop();
    await rm(dir, { recursive: true, force: true });
  });

  it("reads the file and posts its raw bytes to /upload with the token, api level, MIME type and query", async () => {
    const file = join(dir, "boarding pass.pdf");
    const bytes = Buffer.from([0x25, 0x50, 0x44, 0x46, 0x00, 0xff, 0x10]);
    await writeFile(file, bytes);
    app.handler = () => json(200, { attachmentId: "A-1", name: "Boarding.pdf", byteCount: bytes.length });

    const result = await addAttachmentFromPath(
      { path: file, tripId: TRIP, eventId: EVENT, name: "Boarding.pdf" },
      { baseUrl, token: TOKEN },
    );

    expect(app.requests).toHaveLength(1);
    const req = app.requests[0];
    expect(req.method).toBe("POST");
    expect(req.path).toBe("/upload");
    expect(req.query.get("tripId")).toBe(TRIP);
    expect(req.query.get("eventId")).toBe(EVENT);
    expect(req.query.get("name")).toBe("Boarding.pdf");
    expect(req.headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(req.headers["x-tripezgo-api-level"]).toBe("1");
    expect(req.headers["content-type"]).toBe("application/pdf");
    expect(req.body.equals(bytes)).toBe(true);

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toEqual({ attachmentId: "A-1", name: "Boarding.pdf", byteCount: bytes.length });
    expect((result.content[0] as { text: string }).text).toContain("A-1");
  });

  it("names the upload after the file and leaves out ids that were not given", async () => {
    const file = join(dir, "menu.JPG");
    await writeFile(file, "jpeg");
    app.handler = () => json(200, { attachmentId: "A-2", name: "menu.JPG", byteCount: 4 });

    await addAttachmentFromPath({ path: file }, { baseUrl, token: TOKEN });

    const req = app.requests[0];
    expect(req.query.get("name")).toBe("menu.JPG");
    expect(req.query.has("tripId")).toBe(false);
    expect(req.query.has("eventId")).toBe(false);
    expect(req.headers["content-type"]).toBe("image/jpeg");
  });

  it("returns an error result, without calling the app, when the file does not exist", async () => {
    const missing = join(dir, "nope.pdf");

    const result = await addAttachmentFromPath({ path: missing }, { baseUrl, token: TOKEN });

    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toContain(missing);
    expect(app.requests).toHaveLength(0);
  });

  it("returns an error result when path is missing", async () => {
    const result = await addAttachmentFromPath({}, { baseUrl, token: TOKEN });

    expect(result.isError).toBe(true);
    expect(app.requests).toHaveLength(0);
  });

  it("refuses a file over 50 MB before uploading it", async () => {
    const big = join(dir, "video.mov");
    await writeFile(big, "");
    await truncate(big, MAX_UPLOAD_BYTES + 1);

    const result = await addAttachmentFromPath({ path: big }, { baseUrl, token: TOKEN });

    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toMatch(/50 MB/);
    expect(app.requests).toHaveLength(0);
  });

  it("turns a 409 (api level mismatch) into an error that says to update the app or the bridge", async () => {
    const file = join(dir, "a.txt");
    await writeFile(file, "hi");
    app.handler = () => json(409, { error: "Unsupported api level 1; this app speaks 2." });

    const result = await addAttachmentFromPath({ path: file }, { baseUrl, token: TOKEN });

    expect(result.isError).toBe(true);
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("Unsupported api level 1; this app speaks 2.");
    expect(text).toMatch(/Update TripEZGo/);
    expect(text).toMatch(/TripEZGo\/mcp/);
  });

  it("passes another 4xx error from the app through as an error result", async () => {
    const file = join(dir, "a.txt");
    await writeFile(file, "hi");
    app.handler = () => json(403, { error: "This trip is read-only." });

    const result = await addAttachmentFromPath({ path: file }, { baseUrl, token: TOKEN });

    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toContain("This trip is read-only.");
  });

  it("explains how to reconnect when the app cannot be reached", async () => {
    const file = join(dir, "a.txt");
    await writeFile(file, "hi");

    const result = await addAttachmentFromPath({ path: file }, { baseUrl: await closedPortUrl(), token: TOKEN });

    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toMatch(/same Wi-Fi/);
  });
});
