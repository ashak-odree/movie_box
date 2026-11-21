import {
  getCinemetaDetails,
  getCinemetaHomepage,
  getEmbedStreams,
  searchCinemeta,
  suggestCinemeta,
} from "./cinemeta";
import {
  getDramachiDetails,
  getDramachiStreams,
  getDramachiTrending,
  searchDramachi,
} from "./dramachi";

export interface Env {
  ASSETS: { fetch(req: Request): Promise<Response> };
  PASSCODE: string;
  SESSION_SECRET: string;
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
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload));
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

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;

    if (path === "/favicon.ico") {
      return new Response(null, { status: 204 });
    }

    if (!path.startsWith("/api/")) {
      return env.ASSETS.fetch(req);
    }

    if (path === "/api/health") {
      return json({ ok: true, mode: "self-sufficient-edge" });
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
          { id: "all", label: "All", is_bdix: false },
          { id: "moviebox", label: "MovieBox", is_bdix: false },
          { id: "fourkhdhub", label: "4KHDHub", is_bdix: false },
          { id: "dramachi", label: "Dramachi", is_bdix: false },
          { id: "bdix_circleftp", label: "CircleFTP (BDIX)", is_bdix: true },
          { id: "bdix_dhakaflix", label: "DhakaFlix (BDIX)", is_bdix: true },
          { id: "anime", label: "Anime", is_bdix: false },
        ]);
      }

      if (path === "/api/homepage") {
        const provider = url.searchParams.get("provider") || "all";
        const page = Number(url.searchParams.get("page") || "1") || 1;
        if (provider === "dramachi") {
          return json(await getDramachiTrending());
        }
        if (provider === "bdix_circleftp") {
          return json({
            page: 1,
            items: [
              { id: { provider: "bdix_circleftp", value: "http://new.circleftp.net:5000/" }, title: "CircleFTP Main Server (BDIX 100Mbps)", media_type: "movie", year: "BDIX", poster_url: null, season_count: null },
              { id: { provider: "bdix_circleftp", value: "http://circleftp.net/" }, title: "CircleFTP Web Portal (BDIX)", media_type: "movie", year: "BDIX", poster_url: null, season_count: null },
            ],
          });
        }
        if (provider === "bdix_dhakaflix") {
          return json({
            page: 1,
            items: [
              { id: { provider: "bdix_dhakaflix", value: "http://172.16.50.7/DHAKA-FLIX-7/" }, title: "DHAKA-FLIX-7 · English & Hollywood Movies", media_type: "movie", year: "BDIX", poster_url: null, season_count: null },
              { id: { provider: "bdix_dhakaflix", value: "http://172.16.50.14/DHAKA-FLIX-14/" }, title: "DHAKA-FLIX-14 · Hindi, Bangla & Dual Audio", media_type: "movie", year: "BDIX", poster_url: null, season_count: null },
              { id: { provider: "bdix_dhakaflix", value: "http://172.16.50.12/DHAKA-FLIX-12/" }, title: "DHAKA-FLIX-12 · TV & Web Series", media_type: "series", year: "BDIX", poster_url: null, season_count: null },
              { id: { provider: "bdix_dhakaflix", value: "http://172.16.50.9/DHAKA-FLIX-9/" }, title: "DHAKA-FLIX-9 · Anime & Cartoons", media_type: "series", year: "BDIX", poster_url: null, season_count: null },
            ],
          });
        }
        if (provider === "anime") {
          const r = await fetch("https://anime-kitsu.strem.fun/catalog/anime/kitsu-anime-trending.json");
          const d: any = r.ok ? await r.json() : {};
          const items = (d?.metas || [])
            .filter((m: any) => m?.imdb_id)
            .slice(0, 40)
            .map((m: any) => ({
              id: { provider: "anime", value: `series:${m.imdb_id}` },
              title: m.name,
              media_type: "series",
              year: m.releaseInfo ? String(m.releaseInfo).slice(0, 4) : null,
              poster_url: m.poster || null,
              season_count: null,
            }));
          return json({ items, page });
        }
        if (provider === "all") {
          const [movies, series] = await Promise.all([
            getCinemetaHomepage("movies", page).catch(() => ({ items: [] })),
            getCinemetaHomepage("series", page).catch(() => ({ items: [] })),
          ]);
          const merged: any[] = [];
          const max = Math.max(movies.items.length, series.items.length);
          for (let i = 0; i < max; i++) {
            if (movies.items[i]) merged.push(movies.items[i]);
            if (series.items[i]) merged.push(series.items[i]);
          }
          return json({ items: merged.slice(0, 40), page });
        }
        return json(await getCinemetaHomepage("movies", page));
      }

      if (path === "/api/search") {
        const q = (url.searchParams.get("q") || "").trim();
        const provider = url.searchParams.get("provider") || "all";
        const page = Number(url.searchParams.get("page") || "1") || 1;
        if (!q) return json({ items: [] });
        if (provider === "dramachi") {
          return json(await searchDramachi(q, page));
        }
        if (provider === "bdix_circleftp") {
          return json({
            provider,
            page: 1,
            items: [
              { id: { provider: "bdix_circleftp", value: `http://new.circleftp.net:5000/?s=${encodeURIComponent(q)}` }, title: `Search "${q}" on CircleFTP (BDIX Direct)`, media_type: "movie", year: "BDIX", poster_url: null, season_count: null },
              { id: { provider: "bdix_circleftp", value: "http://new.circleftp.net:5000/" }, title: "Open CircleFTP Portal (BDIX 100Mbps)", media_type: "movie", year: "BDIX", poster_url: null, season_count: null },
            ],
          });
        }
        if (provider === "bdix_dhakaflix") {
          return json({
            provider,
            page: 1,
            items: [
              { id: { provider: "bdix_dhakaflix", value: "http://172.16.50.7/DHAKA-FLIX-7/" }, title: `DHAKA-FLIX-7 · Browse/Find "${q}" (Movies)`, media_type: "movie", year: "BDIX", poster_url: null, season_count: null },
              { id: { provider: "bdix_dhakaflix", value: "http://172.16.50.14/DHAKA-FLIX-14/" }, title: `DHAKA-FLIX-14 · Browse/Find "${q}" (Hindi/Dual)`, media_type: "movie", year: "BDIX", poster_url: null, season_count: null },
              { id: { provider: "bdix_dhakaflix", value: "http://172.16.50.12/DHAKA-FLIX-12/" }, title: `DHAKA-FLIX-12 · Browse/Find "${q}" (TV Series)`, media_type: "series", year: "BDIX", poster_url: null, season_count: null },
              { id: { provider: "bdix_dhakaflix", value: "http://172.16.50.9/DHAKA-FLIX-9/" }, title: `DHAKA-FLIX-9 · Browse/Find "${q}" (Anime)`, media_type: "series", year: "BDIX", poster_url: null, season_count: null },
            ],
          });
        }
        if (provider === "anime") {
          const r = await fetch(
            `https://anime-kitsu.strem.fun/catalog/anime/kitsu-anime-list/search=${encodeURIComponent(q)}.json`
          );
          const d: any = r.ok ? await r.json() : {};
          const items = (d?.metas || [])
            .filter((m: any) => m?.imdb_id)
            .slice(0, 30)
            .map((m: any) => ({
              id: { provider: "anime", value: `series:${m.imdb_id}` },
              title: m.name,
              media_type: "series",
              year: m.releaseInfo ? String(m.releaseInfo).slice(0, 4) : null,
              poster_url: m.poster || null,
              season_count: null,
            }));
          return json({ provider: "anime", page, items });
        }
        if (provider === "all") {
          const [cine, drama] = await Promise.all([
            searchCinemeta(q, "all", page).catch(() => ({ items: [] })),
            searchDramachi(q, page).catch(() => ({ items: [] })),
          ]);
          const merged: any[] = [];
          const max = Math.max(cine.items.length, drama.items.length);
          for (let i = 0; i < max; i++) {
            if (cine.items[i]) merged.push(cine.items[i]);
            if (drama.items[i]) merged.push(drama.items[i]);
          }
          return json({ provider: "all", page, items: merged.slice(0, 45) });
        }
        return json(await searchCinemeta(q, "all", page));
      }

      if (path === "/api/suggest") {
        const q = (url.searchParams.get("q") || "").trim();
        if (!q) return json([]);
        return json(await suggestCinemeta(q));
      }

      if (path === "/api/details") {
        const provider = url.searchParams.get("provider") || "";
        const id = url.searchParams.get("id") || "";
        if (provider === "dramachi") {
          return json(await getDramachiDetails(id));
        }
        if (provider === "bdix_circleftp" || provider === "bdix_dhakaflix") {
          const isCircle = provider === "bdix_circleftp";
          return json({
            id: { provider, value: id },
            title: isCircle ? "CircleFTP (BDIX Direct)" : "DhakaFlix (BDIX Direct)",
            media_type: "movie",
            year: "BDIX",
            description:
              "Direct Bangladesh BDIX FTP/Media server. Because your browser is on a BD ISP network, click Open Tab below to browse, stream & download at full 100Mbps BDIX speed.",
            poster_url: null,
            genres: ["BDIX", "Bangladesh", "100Mbps"],
            seasons: [],
            dubs: [],
          });
        }
        return json(await getCinemetaDetails(id));
      }

      if (path === "/api/streams") {
        const provider = url.searchParams.get("provider") || "";
        const id = url.searchParams.get("id") || "";
        const season = Number(url.searchParams.get("season") || "0") || 0;
        const episode = Number(url.searchParams.get("episode") || "0") || 0;
        if (provider === "dramachi") {
          return json(await getDramachiStreams(id, season, episode));
        }
        if (provider === "bdix_circleftp" || provider === "bdix_dhakaflix") {
          return json([
            {
              provider: "embed",
              filename: `Open BDIX Server (${id})`,
              quality: "100Mbps",
              codec: "h264",
              language: "BDIX Direct",
              size_bytes: null,
              season: 0,
              episode: 0,
              resource_id: id,
              mirrors: [{ label: "BDIX Direct", resolver_url: id, headers: [], direct_file: false }],
            },
          ]);
        }
        return json(await getEmbedStreams(id, season, episode));
      }

      if (path === "/api/edge-stream" || path === "/api/edge-download") {
        const isDownload = path === "/api/edge-download";
        const uB64 = url.searchParams.get("u") || "";
        const fname = url.searchParams.get("n") || "movie.mp4";
        const targetUrl = new TextDecoder().decode(b64urlDecode(uB64));
        if (!targetUrl.startsWith("http")) return json({ error: "Invalid URL" }, 400);
        const fwd = new Headers({ "User-Agent": "MovieBox-Tui/0.1.30" });
        const range = req.headers.get("Range");
        if (range) fwd.set("Range", range);
        const upstream = await fetch(targetUrl, { headers: fwd });
        const outHeaders = new Headers();
        for (const h of ["content-type", "content-length", "content-range", "accept-ranges"]) {
          const v = upstream.headers.get(h);
          if (v) outHeaders.set(h, v);
        }
        outHeaders.set("Access-Control-Allow-Origin", "*");
        if (isDownload) {
          const safe = fname.replace(/[^a-zA-Z0-9._ -]/g, "_");
          outHeaders.set("Content-Disposition", `attachment; filename="${safe}"`);
        }
        return new Response(upstream.body, { status: upstream.status, headers: outHeaders });
      }

      if (path === "/api/captions") {
        return json([]);
      }

      if (path === "/api/poster") {
        const imgUrl = url.searchParams.get("url") || "";
        if (!imgUrl) return json({ error: "Missing url" }, 400);
        const resp = await fetch(imgUrl, {
          headers: { "User-Agent": "MovieBox-TUI-Web/1.0" },
        });
        return new Response(resp.body, {
          status: resp.status,
          headers: {
            "Content-Type": resp.headers.get("content-type") || "image/jpeg",
            "Cache-Control": "public, max-age=86400",
          },
        });
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
          interval_secs: 86400,
          current_commit: sha,
          remote_commit: sha,
          last_checked_unix: Math.floor(Date.now() / 1000),
          state: "edge_live",
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
