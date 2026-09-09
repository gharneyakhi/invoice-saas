import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import sharp from "sharp";
import { fetchImageAsPng, logoNeedsWhiteBacking } from "./imageAssets";

/**
 * Shared image-asset pipeline tests (PDF + raster exports).
 *
 * Images are served over local HTTP so `fetchImageAsPng` is exercised for
 * real (status handling, byte limits, sharp normalization, blank
 * rejection) with no external network.
 */

let server: Server;
let baseUrl = "";

beforeAll(async () => {
  const solid = (r: number, g: number, b: number) =>
    sharp({ create: { width: 40, height: 40, channels: 3, background: { r, g, b } } })
      .png()
      .toBuffer();
  const transparent = () =>
    sharp({
      create: { width: 40, height: 40, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
    })
      .png()
      .toBuffer();
  const tiny = () =>
    sharp({ create: { width: 1, height: 1, channels: 3, background: { r: 255, g: 0, b: 0 } } })
      .png()
      .toBuffer();

  const [blue, white, ghost, dot] = await Promise.all([
    solid(0x00, 0x55, 0xff),
    solid(0xff, 0xff, 0xff),
    transparent(),
    tiny(),
  ]);
  const routes = new Map<string, Buffer>([
    ["/blue.png", blue],
    ["/white.png", white],
    ["/ghost.png", ghost],
    ["/dot.png", dot],
  ]);
  server = createServer((req, res) => {
    const body = routes.get(req.url ?? "");
    if (!body) {
      res.writeHead(404);
      res.end();
      return;
    }
    res.writeHead(200, { "Content-Type": "image/png" });
    res.end(body);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
});

describe("fetchImageAsPng", () => {
  it("normalizes valid images to PNG bytes", async () => {
    const png = await fetchImageAsPng(`${baseUrl}/blue.png`);
    expect(png).not.toBeNull();
    expect(png?.subarray(0, 8)).toEqual(
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    );
  });

  it("returns null for HTTP errors", async () => {
    await expect(fetchImageAsPng(`${baseUrl}/missing.png`)).resolves.toBeNull();
  });

  it("rejects fully transparent payloads (they render as bare backing)", async () => {
    await expect(fetchImageAsPng(`${baseUrl}/ghost.png`)).resolves.toBeNull();
  });

  it("rejects placeholder-sized payloads", async () => {
    await expect(fetchImageAsPng(`${baseUrl}/dot.png`)).resolves.toBeNull();
  });
});

describe("logoNeedsWhiteBacking", () => {
  it("backs colored logos so they read on the brand band", async () => {
    const png = (await fetchImageAsPng(`${baseUrl}/blue.png`)) as Buffer;
    await expect(logoNeedsWhiteBacking(png)).resolves.toBe(true);
  });

  it("skips the backing for near-white logos", async () => {
    const png = (await fetchImageAsPng(`${baseUrl}/white.png`)) as Buffer;
    await expect(logoNeedsWhiteBacking(png)).resolves.toBe(false);
  });

  it("fails closed (backs) when the bytes cannot be probed", async () => {
    await expect(logoNeedsWhiteBacking(Buffer.from("not-an-image"))).resolves.toBe(true);
  });
});
