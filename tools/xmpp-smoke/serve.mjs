// Zero-dependency static server for the Phase 1 smoke test page.
// Usage: node tools/xmpp-smoke/serve.mjs   →  http://localhost:8000/?user=alice
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.PORT) || 8000;

createServer(async (req, res) => {
  const path = new URL(req.url, "http://localhost").pathname;
  if (path !== "/" && path !== "/index.html") {
    res.writeHead(404).end("not found");
    return;
  }
  try {
    const html = await readFile(join(here, "index.html"));
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(html);
  } catch (err) {
    res.writeHead(500).end(String(err));
  }
}).listen(port, "127.0.0.1", () => {
  console.log(`XMPP smoke test on http://localhost:${port}/?user=alice`);
});
