import fs from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import { contentTypeFromPath } from "../assets/assetPaths";
import { resolveProjectRelativePath } from "../runtime";
import { sendError, setCorsHeaders } from "./http";

function parseAssetPath(pathname: string): { projectId: string; relativePath: string } | null {
  const prefix = "/api/assets/file/";
  if (!pathname.startsWith(prefix)) return null;
  const rest = pathname.slice(prefix.length);
  const slash = rest.indexOf("/");
  if (slash < 0) return null;
  const projectId = decodeURIComponent(rest.slice(0, slash));
  const relativePath = rest
    .slice(slash + 1)
    .split("/")
    .map((part) => decodeURIComponent(part))
    .join("/");
  if (!projectId || !relativePath) return null;
  return { projectId, relativePath };
}

function parseRangeHeader(range: string, size: number): { start: number; end: number } | null {
  const match = range.match(/^bytes=(\d*)-(\d*)$/);
  if (!match) return null;
  const rawStart = match[1] || "";
  const rawEnd = match[2] || "";
  if (!rawStart && !rawEnd) return null;
  if (!rawStart) {
    const suffixLength = Number.parseInt(rawEnd, 10);
    if (!Number.isFinite(suffixLength) || suffixLength <= 0) return null;
    const start = Math.max(0, size - suffixLength);
    return { start, end: size - 1 };
  }
  const start = Number.parseInt(rawStart, 10);
  const end = rawEnd ? Number.parseInt(rawEnd, 10) : size - 1;
  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end < start || start >= size) return null;
  return { start, end: Math.min(end, size - 1) };
}

export function handleAssetFileRequest(req: IncomingMessage, res: ServerResponse, pathname: string): boolean {
  const parsed = parseAssetPath(pathname);
  if (!parsed) return false;
  setCorsHeaders(req, res);
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.writeHead(405, { allow: "GET, HEAD" });
    res.end();
    return true;
  }
  try {
    const absolutePath = resolveProjectRelativePath(parsed.projectId, parsed.relativePath);
    const stat = fs.statSync(absolutePath);
    if (!stat.isFile()) throw new Error("Asset not found");
    const contentType = contentTypeFromPath(absolutePath);
    const rangeHeader = typeof req.headers.range === "string" ? req.headers.range : "";
    const range = rangeHeader ? parseRangeHeader(rangeHeader, stat.size) : null;
    if (rangeHeader && !range) {
      res.writeHead(416, { "content-range": `bytes */${stat.size}` });
      res.end();
      return true;
    }
    if (range) {
      const length = range.end - range.start + 1;
      res.writeHead(206, {
        "accept-ranges": "bytes",
        "content-type": contentType,
        "content-length": length,
        "content-range": `bytes ${range.start}-${range.end}/${stat.size}`,
      });
      if (req.method === "HEAD") {
        res.end();
      } else {
        fs.createReadStream(absolutePath, { start: range.start, end: range.end }).pipe(res);
      }
      return true;
    }
    res.writeHead(200, {
      "accept-ranges": "bytes",
      "content-type": contentType,
      "content-length": stat.size,
      "last-modified": stat.mtime.toUTCString(),
      "content-disposition": `inline; filename="${path.basename(absolutePath).replace(/"/g, "")}"`,
    });
    if (req.method === "HEAD") res.end();
    else fs.createReadStream(absolutePath).pipe(res);
  } catch (error) {
    sendError(req, res, 404, error);
  }
  return true;
}

