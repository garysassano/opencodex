import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";

const fixtureDir = process.argv[2];
if (!fixtureDir) throw new Error("usage: bun mise-service-fixture-registry.ts <fixture-directory>");

const packageName = "@bitkyc08/opencodex";
const port = 4873;
const hostname = process.env.FIXTURE_REGISTRY_HOST ?? "127.0.0.1";
const publicHost = process.env.FIXTURE_REGISTRY_PUBLIC_HOST ?? hostname;
const versions: Record<string, Record<string, unknown>> = {};
const tarballs = new Map<string, string>();

for (const filename of readdirSync(fixtureDir).filter(name => name.endsWith(".tgz")).sort()) {
  const path = join(fixtureDir, filename);
  const archive = readFileSync(path);
  const extracted = Bun.spawnSync(["tar", "-xOf", path, "package/package.json"]);
  if (extracted.exitCode !== 0) throw new Error(`could not read package.json from ${filename}`);
  const manifest = JSON.parse(extracted.stdout.toString()) as Record<string, unknown> & { version?: unknown };
  if (typeof manifest.version !== "string") throw new Error(`${filename} has no package version`);
  const tarballPath = `/@bitkyc08/opencodex/-/${filename}`;
  versions[manifest.version] = {
    ...manifest,
    dist: {
      integrity: `sha512-${createHash("sha512").update(archive).digest("base64")}`,
      shasum: createHash("sha1").update(archive).digest("hex"),
      tarball: `http://${publicHost}:${port}${tarballPath}`,
    },
  };
  tarballs.set(tarballPath, path);
}

const orderedVersions = Object.keys(versions).sort();
if (orderedVersions.length !== 2) throw new Error("exactly two fixture tarballs are required");
const packument = {
  _id: packageName,
  name: packageName,
  "dist-tags": { latest: orderedVersions.at(-1) },
  versions,
  time: Object.fromEntries(orderedVersions.map(version => [version, "2026-01-01T00:00:00.000Z"])),
};

const server = Bun.serve({
  hostname,
  port,
  async fetch(request) {
    const url = new URL(request.url);
    const decodedPath = decodeURIComponent(url.pathname);
    if (decodedPath === `/${packageName}`) {
      return Response.json(packument, { headers: { "cache-control": "no-store" } });
    }
    const exactVersion = decodedPath.slice(`/${packageName}/`.length);
    if (decodedPath.startsWith(`/${packageName}/`) && versions[exactVersion]) {
      return Response.json(versions[exactVersion], { headers: { "cache-control": "no-store" } });
    }
    const tarball = tarballs.get(decodedPath);
    if (tarball) return new Response(Bun.file(tarball));

    const upstream = new URL(`${url.pathname}${url.search}`, "https://registry.npmjs.org");
    const headers = new Headers(request.headers);
    headers.delete("host");
    headers.delete("authorization");
    const response = await fetch(upstream, { method: request.method, headers, redirect: "follow" });
    const responseHeaders = new Headers(response.headers);
    responseHeaders.delete("content-encoding");
    responseHeaders.delete("content-length");
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: responseHeaders,
    });
  },
});

console.log(`fixture registry listening at ${server.url} for ${orderedVersions.join(" and ")}`);
