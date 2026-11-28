import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { it } from "node:test";
import { startServer } from "./support/server.ts";
import { FakeChHost, startFakeChDebugger } from "./support/ch-host.ts";
import { PNG } from "./support/image.ts";

it("serves authenticated GET/HEAD local images through the existing Markdown URL", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "web-file-media-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, "图片 with spaces.png");
  writeFileSync(path, Buffer.from(PNG, "base64"));
  writeFileSync(join(root, "notes.txt"), "not an image");
  const debug = await startFakeChDebugger(new FakeChHost());
  t.after(() => debug.close());
  const url = new URL(
    await startServer(
      t,
      resolve(import.meta.dirname, ".."),
      ["--import", "tsx", "src/main.ts"],
      ["--session-source", "codexhost", "--ch-cdp", debug.endpoint],
      { authenticated: true },
    ),
  );
  const endpoint = new URL(`/api/file?path=${encodeURIComponent(path)}`, url);
  assert.equal((await fetch(endpoint)).status, 401);
  const headers = { authorization: `Bearer ${url.searchParams.get("token")}` };
  const image = await fetch(endpoint, { headers });
  assert.equal(image.status, 200);
  assert.equal(image.headers.get("content-type"), "image/png");
  assert.equal(image.headers.get("cache-control"), "private, no-cache");
  assert.equal(image.headers.get("vary"), "Authorization, Cookie");
  const etag = image.headers.get("etag");
  assert.ok(etag);
  assert.match(etag, /^"[a-f0-9]{64}\.png"$/u);
  assert.deepEqual(Buffer.from(await image.arrayBuffer()), Buffer.from(PNG, "base64"));

  const notModified = await fetch(endpoint, {
    headers: { ...headers, "if-none-match": etag },
  });
  assert.equal(notModified.status, 304);
  assert.equal(notModified.headers.get("etag"), etag);
  assert.equal(notModified.headers.get("cache-control"), "private, no-cache");
  assert.equal((await notModified.arrayBuffer()).byteLength, 0);

  const head = await fetch(endpoint, { headers, method: "HEAD" });
  assert.equal(head.status, 200);
  assert.equal(head.headers.get("etag"), etag);
  assert.equal(Number(head.headers.get("content-length")), Buffer.from(PNG, "base64").length);
  assert.equal((await head.arrayBuffer()).byteLength, 0);

  const headNotModified = await fetch(endpoint, {
    headers: { ...headers, "if-none-match": etag },
    method: "HEAD",
  });
  assert.equal(headNotModified.status, 304);

  // In-place file edits change the ETag and return the new bytes on revalidation.
  const gif = Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", "base64");
  writeFileSync(path, gif);
  const updated = await fetch(endpoint, {
    headers: { ...headers, "if-none-match": etag },
  });
  assert.equal(updated.status, 200);
  assert.equal(updated.headers.get("content-type"), "image/gif");
  assert.notEqual(updated.headers.get("etag"), etag);
  assert.deepEqual(Buffer.from(await updated.arrayBuffer()), gif);

  for (const name of ["missing.png", "notes.txt"]) {
    endpoint.searchParams.set("path", join(root, name));
    const missing = await fetch(endpoint, { headers });
    assert.equal(missing.status, 404);
    assert.equal(missing.headers.get("cache-control"), "private, no-store");
  }
  endpoint.search = "";
  const bad = await fetch(endpoint, { headers });
  assert.equal(bad.status, 400);
  assert.equal(bad.headers.get("cache-control"), "private, no-store");
});
