import {
  getCaptions,
  getDetails,
  getHomepage,
  getStreams,
  searchMovieBox,
  suggestMovieBox,
} from "./moviebox";

export interface Env {
  ASSETS: { fetch(req: Request): Promise<Response> };
  PASSCODE: string;
  SESSION_SECRET: string;
  BACKEND_URL?: string;
}

const SESSION_COOKIE = "mb_session";
const SESSION_TTL_SEC = 7 * 24 * 3600;

function json(data: unknown, status = 200, extraHeaders?: Record<string, string>) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      ...extraHeaders,
    },
  });
}

function b64urlEncode(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlDecode(str: string): Uint8Array {
  const pad = str.length % 4 === 0 ? "" : "=".repeat(4 - (str.length % 4));
  const b64 = str.replace(/-/g, "+").replace(/_/g, "/") + pad;
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function hmacSign(secret: string, payload: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(payload)
  );
  return b64urlEncode(new Uint8Array(sig));
}

async function signPayload(secret: string, obj: unknown): Promise<string> {
  const payload = b64urlEncode(new TextEncoder().encode(JSON.stringify(obj)));
  const sig = await hmacSign(secret, payload);
  return `${payload}.${sig}`;
}

async function verifyPayload<T>(secret: string, token: string): Promise<T | null> {
  const dot = token.indexOf(".");
  if (dot <= 0) return null;
  const payload = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expected = await hmacSign(secret, payload);
  if (sig !== expected) return null;
  try {
    const raw = new TextDecoder().decode(b64urlDecode(payload));
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

function getCookie(req: Request, name: string): string | null {
  const hdr = req.headers.get("Cookie") || "";
  for (const part of hdr.split(";")) {
    const idx = part.indexOf("=");
    if (idx > 0 && part.slice(0, idx).trim() === name) {
      return decodeURIComponent(part.slice(idx + 1).trim());
    }
  }
  return null;
}

async function isAuthenticated(req: Request, env: Env): Promise<boolean> {
  const cookie = getCookie(req, SESSION_COOKIE);
  if (!cookie) return false;
  const data = await verifyPayload<{ iat: number }>(env.SESSION_SECRET, cookie);
  if (!data) return false;
  return Math.floor(Date.now() / 1000) - data.iat < SESSION_TTL_SEC;
}

function srtToVtt(srt: string): string {
  const lines = srt.split(/\r?\n/).map((l) =>
    l.includes("-->") ? l.replace(/,/g, ".") : l
  );
  return `WEBVTT\n\n${lines.join("\n")}`;
}

async function proxyUpstream(
  url: string,
  headersList: [string, string][],
  req: Request,
  attachmentName?: string
): Promise<Response> {
  const fwd = new Headers();
  let hasUa = false;
  for (const [k, v] of headersList || []) {
    if (k.toLowerCase() === "user-agent") hasUa = true;
    fwd.set(k, v);
  }
  if (!hasUa) {
    fwd.set("User-Agent", "MovieBox-Tui/0.1.30");
  }
  const range = req.headers.get("Range");
  if (range) fwd.set("Range", range);

  const upstream = await fetch(url, { headers: fwd });
  const outHeaders = new Headers();
  for (const h of ["content-type", "content-length", "content-range", "accept-ranges"]) {
    const val = upstream.headers.get(h);
    if (val) outHeaders.set(h, val);
  }
  outHeaders.set("Access-Control-Allow-Origin", "*");
  if (attachmentName) {
    const safe = attachmentName.replace(/[^a-zA-Z0-9._ -]/g, "_");
    outHeaders.set("Content-Disposition", `attachment; filename="${safe}"`);
  }
  return new Response(upstream.body, {
    status: upstream.status,
    headers: outHeaders,
  });
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;

    if (!path.startsWith("/api/")) {
      return env.ASSETS.fetch(req);
    }

    if (env.BACKEND_URL) {
      const target = `${env.BACKEND_URL.replace(/\/$/, "")}${path}${url.search}`;
      const fwdHeaders = new Headers(req.headers);
      fwdHeaders.delete("host");
      const resp = await fetch(target, {
        method: req.method,
        headers: fwdHeaders,
        body: req.method === "GET" || req.method === "HEAD" ? undefined : req.body,
        redirect: "manual",
      });
      return new Response(resp.body, {
        status: resp.status,
        headers: resp.headers,
      });
    }

    if (path === "/api/health") {
      return json({ ok: true });
    }

    if (path === "/api/auth/check") {
      return json({ authenticated: await isAuthenticated(req, env) });
    }

    if (path === "/api/auth/login" && req.method === "POST") {
      const body: any = await req.json().catch(() => ({}));
      if (String(body?.passcode || "").trim() !== env.PASSCODE) {
        return json({ authenticated: false, error: "Access denied: wrong passphrase" }, 401);
      }
      const token = await signPayload(env.SESSION_SECRET, {
        iat: Math.floor(Date.now() / 1000),
      });
      return json(
        { authenticated: true },
        200,
        {
          "Set-Cookie": `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_TTL_SEC}`,
        }
      );
    }

    if (path === "/api/auth/logout" && req.method === "POST") {
      return json(
        { authenticated: false },
        200,
        {
          "Set-Cookie": `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`,
        }
      );
    }

    if (!(await isAuthenticated(req, env))) {
      return json({ authenticated: false, error: "Authentication required" }, 401);
    }

    try {
      if (path === "/api/providers") {
        return json([
          { id: "moviebox", label: "MovieBox", is_bdix: false },
        ]);
      }

      if (path === "/api/homepage") {
        const page = Number(url.searchParams.get("page") || "1") || 1;
        return json(await getHomepage(page));
      }

      if (path === "/api/search") {
        const q = (url.searchParams.get("q") || "").trim();
        const page = Number(url.searchParams.get("page") || "1") || 1;
        if (!q) return json({ items: [] });
        return json(await searchMovieBox(q, page));
      }

      if (path === "/api/suggest") {
        const q = (url.searchParams.get("q") || "").trim();
        if (!q) return json([]);
        return json(await suggestMovieBox(q));
      }

      if (path === "/api/details") {
        const id = url.searchParams.get("id") || "";
        return json(await getDetails(id));
      }

      if (path === "/api/streams") {
        const id = url.searchParams.get("id") || "";
        const season = Number(url.searchParams.get("season") || "0") || 0;
        const episode = Number(url.searchParams.get("episode") || "0") || 0;
        return json(await getStreams(id, season, episode));
      }

      if (path === "/api/resolve" && req.method === "POST") {
        const body: any = await req.json().catch(() => ({}));
        const rel = body?.release;
        const mirror = rel?.mirrors?.[0];
        const targetUrl = body?.url || mirror?.resolver_url;
        if (!targetUrl) return json({ error: "No stream URL found" }, 404);
        const headers: [string, string][] = body?.headers?.length ? body.headers : (mirror?.headers || []);
        const filename = body?.filename || rel?.filename || "video.mp4";
        const lower = targetUrl.toLowerCase();
        const isHls = lower.includes(".m3u8");
        const isDash = lower.includes(".mpd");

        const token = await signPayload(env.SESSION_SECRET, {
          url: targetUrl,
          headers,
          filename,
          exp: Math.floor(Date.now() / 1000) + 6 * 3600,
        });

        const streamUrl = isDash
          ? `/api/manifest/${encodeURIComponent(token)}/index.mpd`
          : isHls
            ? `/api/manifest/${encodeURIComponent(token)}/index.m3u8`
            : `/api/stream?token=${encodeURIComponent(token)}`;

        return json({
          stream_url: streamUrl,
          download_url: `/api/download?token=${encodeURIComponent(token)}&filename=${encodeURIComponent(filename)}`,
          is_hls: isHls,
          is_dash: isDash,
          filename,
        });
      }

      if (path === "/api/captions") {
        const id = url.searchParams.get("id") || "";
        const rid = url.searchParams.get("resource_id") || "";
        const subs = await getCaptions(id, rid);
        const out = await Promise.all(
          subs.map(async (s: any) => {
            const token = await signPayload(env.SESSION_SECRET, {
              url: s.url,
              headers: [],
              filename: `${s.name}.vtt`,
              exp: Math.floor(Date.now() / 1000) + 6 * 3600,
            });
            return { name: s.name, url: `/api/stream?token=${encodeURIComponent(token)}&vtt=1` };
          })
        );
        return json(out);
      }

      if (path === "/api/poster") {
        const imgUrl = url.searchParams.get("url") || "";
        if (!imgUrl) return json({ error: "Missing url" }, 400);
        const resp = await fetch(imgUrl, {
          headers: { "User-Agent": "MovieBox-Tui/0.1.30" },
        });
        return new Response(resp.body, {
          status: resp.status,
          headers: {
            "Content-Type": resp.headers.get("content-type") || "image/jpeg",
            "Cache-Control": "public, max-age=86400",
          },
        });
      }

      if (path === "/api/stream") {
        const token = url.searchParams.get("token") || "";
        const target = await verifyPayload<{ url: string; headers: [string, string][]; exp: number }>(
          env.SESSION_SECRET,
          token
        );
        if (!target) return json({ error: "Invalid stream token" }, 404);

        if (url.searchParams.get("vtt") === "1") {
          const resp = await fetch(target.url, { headers: { "User-Agent": "MovieBox-Tui/0.1.30" } });
          const text = await resp.text();
          const body = text.trimStart().startsWith("WEBVTT") ? text : srtToVtt(text);
          return new Response(body, {
            headers: { "Content-Type": "text/vtt; charset=utf-8" },
          });
        }

        if (!target.headers || target.headers.length === 0) {
          return Response.redirect(target.url, 307);
        }
        return proxyUpstream(target.url, target.headers, req);
      }

      if (path.startsWith("/api/manifest/")) {
        const rest = path.slice("/api/manifest/".length);
        const slash = rest.indexOf("/");
        if (slash <= 0) return json({ error: "Bad manifest path" }, 400);
        const token = decodeURIComponent(rest.slice(0, slash));
        const relpath = rest.slice(slash + 1);
        const target = await verifyPayload<{ url: string; headers: [string, string][]; exp: number }>(
          env.SESSION_SECRET,
          token
        );
        if (!target) return json({ error: "Invalid manifest token" }, 404);

        const upstreamUrl =
          relpath === "index.mpd" || relpath === "index.m3u8"
            ? target.url
            : new URL(relpath, target.url).toString();
        return proxyUpstream(upstreamUrl, target.headers, req);
      }

      if (path === "/api/download") {
        const token = url.searchParams.get("token") || "";
        const target = await verifyPayload<{ url: string; headers: [string, string][]; filename?: string }>(
          env.SESSION_SECRET,
          token
        );
        if (!target) return json({ error: "Invalid download token" }, 404);
        if (!target.headers || target.headers.length === 0) {
          return Response.redirect(target.url, 307);
        }
        const fname = url.searchParams.get("filename") || target.filename || "movie.mp4";
        return proxyUpstream(target.url, target.headers, req, fname);
      }

      if (path === "/api/updater/status" || path === "/api/updater/check") {
        const gh = await fetch("https://api.github.com/repos/mesamirh/MovieBox-Tui/commits/main", {
          headers: { "User-Agent": "MovieBox-Worker" },
        })
          .then((r) => (r.ok ? r.json() : null))
          .catch(() => null);
        const sha = (gh as any)?.sha ? String((gh as any).sha).slice(0, 7) : null;
        const st = {
          enabled: true,
          interval_secs: 1800,
          current_commit: sha,
          remote_commit: sha,
          last_checked_unix: Math.floor(Date.now() / 1000),
          state: "up_to_date",
          last_error: null,
        };
        return json(path.endsWith("/check") ? { updated: false, status: st } : st);
      }

      return json({ error: "Not found" }, 404);
    } catch (err: any) {
      return json({ error: err?.message || "Internal error" }, 502);
    }
  },
};

