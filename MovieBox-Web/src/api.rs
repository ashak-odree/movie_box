use axum::{
    Json,
    body::Body,
    extract::{Path, Query, State},
    http::{HeaderMap, StatusCode, header},
    response::{IntoResponse, Response},
};
use moviebox_tui::providers::{
    ReleaseProvider, ResolutionIntent,
    models::{ProviderKind, Release},
    moviebox::adapt::{moviebox_play_info_json_to_releases, moviebox_resource_json_to_releases},
};
use serde::{Deserialize, Serialize};

use crate::state::{AppState, StreamTarget, unix_now};
use crate::updater;

type ApiError = (StatusCode, Json<serde_json::Value>);

fn api_err(status: StatusCode, msg: impl Into<String>) -> ApiError {
    (status, Json(serde_json::json!({ "error": msg.into() })))
}

#[derive(Serialize)]
pub struct ProviderInfo {
    pub id: &'static str,
    pub label: &'static str,
    pub is_bdix: bool,
}

pub async fn providers() -> Json<Vec<ProviderInfo>> {
    let list = ProviderKind::ENABLED
        .iter()
        .map(|p| ProviderInfo {
            id: p.cache_key(),
            label: p.label(),
            is_bdix: p.is_bdix(),
        })
        .collect();
    Json(list)
}

#[derive(Deserialize)]
pub struct HomepageQuery {
    pub tab: Option<String>,
    pub page: Option<usize>,
}

pub async fn homepage(
    State(state): State<AppState>,
    Query(q): Query<HomepageQuery>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let tab = q.tab.as_deref().unwrap_or("");
    let page = q.page.unwrap_or(1).max(1);
    let (items, metrics) = state
        .service
        .homepage(tab, page)
        .await
        .map_err(|e| api_err(StatusCode::BAD_GATEWAY, e))?;

    Ok(Json(serde_json::json!({
        "items": items,
        "metrics": metrics,
        "page": page,
    })))
}

#[derive(Deserialize)]
pub struct SearchQuery {
    pub q: String,
    pub provider: Option<String>,
    pub page: Option<usize>,
}

pub async fn search(
    State(state): State<AppState>,
    Query(q): Query<SearchQuery>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let query = q.q.trim();
    if query.is_empty() {
        return Ok(Json(serde_json::json!({ "items": [] })));
    }
    let provider = q
        .provider
        .as_deref()
        .and_then(ProviderKind::parse)
        .unwrap_or(ProviderKind::MovieBox);
    let page = q.page.unwrap_or(1).max(1);

    let items = state
        .service
        .search_typed(provider, query, page)
        .await
        .map_err(|e| api_err(StatusCode::BAD_GATEWAY, e.to_string()))?;

    Ok(Json(serde_json::json!({
        "provider": provider.cache_key(),
        "page": page,
        "items": items,
    })))
}

#[derive(Deserialize)]
pub struct SuggestQuery {
    pub q: String,
}

pub async fn suggest(
    State(state): State<AppState>,
    Query(q): Query<SuggestQuery>,
) -> Result<Json<Vec<String>>, ApiError> {
    let query = q.q.trim();
    if query.is_empty() {
        return Ok(Json(Vec::new()));
    }
    let suggestions = state
        .service
        .suggest(query)
        .await
        .unwrap_or_default();
    Ok(Json(suggestions))
}

#[derive(Deserialize)]
pub struct DetailsQuery {
    pub provider: Option<String>,
    pub id: String,
}

pub async fn details(
    State(state): State<AppState>,
    Query(q): Query<DetailsQuery>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let provider = q
        .provider
        .as_deref()
        .and_then(ProviderKind::parse)
        .unwrap_or(ProviderKind::MovieBox);

    let details = state
        .service
        .details_typed(provider, &q.id)
        .await
        .map_err(|e| api_err(StatusCode::BAD_GATEWAY, e.to_string()))?;

    Ok(Json(serde_json::json!(details)))
}

#[derive(Deserialize)]
pub struct StreamsQuery {
    pub provider: Option<String>,
    pub id: String,
    pub season: Option<usize>,
    pub episode: Option<usize>,
}

pub async fn streams(
    State(state): State<AppState>,
    Query(q): Query<StreamsQuery>,
) -> Result<Json<Vec<Release>>, ApiError> {
    let provider = q
        .provider
        .as_deref()
        .and_then(ProviderKind::parse)
        .unwrap_or(ProviderKind::MovieBox);
    let season = q.season.unwrap_or(0);
    let episode = q.episode.unwrap_or(0);

    let releases = match provider {
        ProviderKind::MovieBox => {
            let (play_res, res_res) = tokio::join!(
                state.service.client.get_play_info(&q.id, season, episode),
                state
                    .service
                    .client
                    .get_resources(&q.id, season, episode, 1, None, 20)
            );
            let mut list = Vec::new();
            if let Ok(payload) = res_res {
                list.extend(moviebox_resource_json_to_releases(&payload));
            }
            if let Ok(payload) = play_res {
                list.extend(moviebox_play_info_json_to_releases(
                    &payload,
                    season,
                    episode,
                    moviebox_tui::net::APP_HTTP_USER_AGENT,
                ));
            }
            // Prefer direct MP4/HLS over DASH .mpd when available
            list.sort_by_key(|r| {
                let u = r
                    .mirrors
                    .first()
                    .map(|m| m.resolver_url.to_ascii_lowercase())
                    .unwrap_or_default();
                if u.contains(".mpd") { 1 } else { 0 }
            });
            list
        }
        ProviderKind::FourKHdHub => {
            let fourk = state
                .service
                .fourk_client
                .as_ref()
                .ok_or_else(|| api_err(StatusCode::SERVICE_UNAVAILABLE, "4KHDHub unavailable"))?;
            fourk
                .episode_streams(&q.id, season, episode)
                .await
                .map_err(|e| api_err(StatusCode::BAD_GATEWAY, e.to_string()))?
        }
        ProviderKind::Dramachi => state
            .service
            .dramachi_client
            .episode_streams(&q.id, season, episode)
            .await
            .map_err(|e| api_err(StatusCode::BAD_GATEWAY, e.to_string()))?,
        ProviderKind::BdixCircleFtp => state
            .service
            .circleftp_client
            .episode_streams(&q.id, season, episode)
            .await
            .map_err(|e| api_err(StatusCode::BAD_GATEWAY, e.to_string()))?,
        ProviderKind::BdixDhakaFlix => state
            .service
            .dhakaflix_client
            .episode_streams(&q.id, season, episode)
            .await
            .map_err(|e| api_err(StatusCode::BAD_GATEWAY, e.to_string()))?,
        ProviderKind::Addons => Vec::new(),
    };

    Ok(Json(releases))
}

#[derive(Deserialize)]
pub struct ResolveRequest {
    pub release: Option<Release>,
    pub url: Option<String>,
    #[serde(default)]
    pub headers: Vec<(String, String)>,
    pub filename: Option<String>,
}

#[derive(Serialize)]
pub struct ResolveResponse {
    pub stream_url: String,
    pub download_url: String,
    pub is_hls: bool,
    pub is_dash: bool,
    pub filename: String,
}

pub async fn resolve(
    State(state): State<AppState>,
    Json(req): Json<ResolveRequest>,
) -> Result<Json<ResolveResponse>, ApiError> {
    let (target_url, target_headers, filename) = if let Some(release) = req.release {
        if release.provider == ProviderKind::FourKHdHub {
            let fourk = state
                .service
                .fourk_client
                .as_ref()
                .ok_or_else(|| api_err(StatusCode::SERVICE_UNAVAILABLE, "4KHDHub unavailable"))?;
            let resolved = fourk
                .resolve_release(&release, ResolutionIntent::Playback)
                .await
                .map_err(|e| api_err(StatusCode::BAD_GATEWAY, e.user_message()))?;
            (resolved.url, resolved.headers, release.filename)
        } else {
            let mirror = release
                .mirrors
                .first()
                .ok_or_else(|| api_err(StatusCode::NOT_FOUND, "No mirror URL in release"))?;
            let url = req.url.unwrap_or_else(|| mirror.resolver_url.clone());
            let hdrs = if req.headers.is_empty() {
                mirror.headers.clone()
            } else {
                req.headers
            };
            (url, hdrs, req.filename.unwrap_or(release.filename))
        }
    } else if let Some(url) = req.url {
        (
            url,
            req.headers,
            req.filename.unwrap_or_else(|| "video.mp4".to_string()),
        )
    } else {
        return Err(api_err(StatusCode::BAD_REQUEST, "Missing release or url"));
    };

    let lower_url = target_url.to_ascii_lowercase();
    let is_hls = lower_url.contains(".m3u8");
    let is_dash = lower_url.contains(".mpd");
    let token = state
        .register_stream_target(StreamTarget {
            url: target_url,
            headers: target_headers,
            filename: Some(filename.clone()),
            created_at: unix_now(),
        })
        .await;

    let encoded_name = percent_encoding::utf8_percent_encode(
        &filename,
        percent_encoding::NON_ALPHANUMERIC,
    )
    .to_string();

    let stream_url = if is_dash {
        format!("/api/manifest/{token}/index.mpd")
    } else if is_hls {
        format!("/api/manifest/{token}/index.m3u8")
    } else {
        format!("/api/stream?token={token}")
    };

    Ok(Json(ResolveResponse {
        stream_url,
        download_url: format!("/api/download?token={token}&filename={encoded_name}"),
        is_hls,
        is_dash,
        filename,
    }))
}

#[derive(Deserialize)]
pub struct CaptionsQuery {
    pub id: String,
    pub resource_id: Option<String>,
    pub season: Option<usize>,
    pub episode: Option<usize>,
}

pub async fn captions(
    State(state): State<AppState>,
    Query(q): Query<CaptionsQuery>,
) -> Result<Json<Vec<serde_json::Value>>, ApiError> {
    let rid = q.resource_id.as_deref().unwrap_or("");
    let subs = state
        .service
        .get_ext_captions(
            &q.id,
            rid,
            &[],
            q.season.unwrap_or(0),
            q.episode.unwrap_or(0),
        )
        .await
        .unwrap_or_default();

    let mut out = Vec::with_capacity(subs.len());
    for sub in subs {
        let token = state
            .register_stream_target(StreamTarget {
                url: sub.url.clone(),
                headers: Vec::new(),
                filename: Some(format!("{}.vtt", sub.name)),
                created_at: unix_now(),
            })
            .await;
        out.push(serde_json::json!({
            "name": sub.name,
            "url": format!("/api/stream?token={token}&vtt=1"),
        }));
    }

    Ok(Json(out))
}

#[derive(Deserialize)]
pub struct PosterQuery {
    pub url: String,
}

pub async fn poster(
    State(state): State<AppState>,
    Query(q): Query<PosterQuery>,
) -> Result<Response, ApiError> {
    let bytes = state
        .service
        .fetch_poster_bytes(&q.url)
        .await
        .ok_or_else(|| api_err(StatusCode::NOT_FOUND, "Poster not found"))?;

    let content_type = if bytes.starts_with(&[0x89, 0x50, 0x4E, 0x47]) {
        "image/png"
    } else if bytes.starts_with(b"RIFF") {
        "image/webp"
    } else {
        "image/jpeg"
    };

    Ok((
        StatusCode::OK,
        [
            (header::CONTENT_TYPE, content_type),
            (header::CACHE_CONTROL, "public, max-age=86400"),
        ],
        bytes,
    )
        .into_response())
}

#[derive(Deserialize)]
pub struct StreamQuery {
    pub token: String,
    pub vtt: Option<u8>,
    pub filename: Option<String>,
}

fn extract_host_authority(url: &str) -> Option<String> {
    let after_scheme = url
        .strip_prefix("https://")
        .or_else(|| url.strip_prefix("http://"))?;
    let authority = after_scheme.split('/').next()?;
    if authority.is_empty() {
        None
    } else {
        Some(authority.to_string())
    }
}

fn should_forward_header(forward_all: bool, name: &str) -> bool {
    forward_all
        || name.eq_ignore_ascii_case("user-agent")
        || name.eq_ignore_ascii_case("referer")
        || name.eq_ignore_ascii_case("cookie")
        || name.eq_ignore_ascii_case("origin")
}

fn build_upstream_request(
    client: &reqwest::Client,
    target: &StreamTarget,
    range_header: Option<&str>,
) -> reqwest::RequestBuilder {
    let mut req = client.get(&target.url);
    let target_host = extract_host_authority(&target.url);
    let referer_host = target
        .headers
        .iter()
        .find(|(n, _)| n.eq_ignore_ascii_case("referer"))
        .and_then(|(_, v)| extract_host_authority(v));
    let same_host = target_host.is_some() && target_host == referer_host;

    let mut has_ua = false;
    for (name, value) in &target.headers {
        if name.eq_ignore_ascii_case("user-agent") {
            has_ua = true;
        }
        if should_forward_header(same_host, name) {
            req = req.header(name.as_str(), value.as_str());
        }
    }
    if !has_ua {
        req = req.header("User-Agent", moviebox_tui::net::APP_HTTP_USER_AGENT);
    }
    if let Some(range) = range_header {
        req = req.header("Range", range);
    }
    req
}

fn srt_to_vtt(srt: &str) -> String {
    let mut out = String::from("WEBVTT\n\n");
    for line in srt.lines() {
        let trimmed = line.trim_end_matches('\r');
        if trimmed.contains("-->") {
            out.push_str(&trimmed.replace(',', "."));
        } else {
            out.push_str(trimmed);
        }
        out.push('\n');
    }
    out
}

pub async fn stream(
    State(state): State<AppState>,
    Query(q): Query<StreamQuery>,
    req_headers: HeaderMap,
) -> Result<Response, ApiError> {
    let target = state
        .get_stream_target(&q.token)
        .await
        .ok_or_else(|| api_err(StatusCode::NOT_FOUND, "Stream token expired or invalid"))?;

    if q.vtt == Some(1) {
        let resp = build_upstream_request(&state.http_client, &target, None)
            .send()
            .await
            .map_err(|e| api_err(StatusCode::BAD_GATEWAY, e.to_string()))?;
        let text = resp
            .text()
            .await
            .map_err(|e| api_err(StatusCode::BAD_GATEWAY, e.to_string()))?;
        let body = if text.trim_start().starts_with("WEBVTT") {
            text
        } else {
            srt_to_vtt(&text)
        };
        return Ok((
            StatusCode::OK,
            [(header::CONTENT_TYPE, "text/vtt; charset=utf-8")],
            body,
        )
            .into_response());
    }

    let range = req_headers
        .get(header::RANGE)
        .and_then(|v| v.to_str().ok());

    let upstream = build_upstream_request(&state.http_client, &target, range)
        .send()
        .await
        .map_err(|e| api_err(StatusCode::BAD_GATEWAY, e.to_string()))?;

    let status = StatusCode::from_u16(upstream.status().as_u16()).unwrap_or(StatusCode::OK);
    let mut builder = Response::builder().status(status);

    for name in [
        header::CONTENT_TYPE,
        header::CONTENT_LENGTH,
        header::CONTENT_RANGE,
        header::ACCEPT_RANGES,
    ] {
        if let Some(val) = upstream.headers().get(&name) {
            builder = builder.header(name, val);
        }
    }

    let byte_stream = upstream.bytes_stream();
    let body = Body::from_stream(byte_stream);

    builder
        .body(body)
        .map_err(|e| api_err(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))
}

pub async fn stream_manifest_segment(
    State(state): State<AppState>,
    Path((token, relpath)): Path<(String, String)>,
    req_headers: HeaderMap,
) -> Result<Response, ApiError> {
    let mut target = state
        .get_stream_target(&token)
        .await
        .ok_or_else(|| api_err(StatusCode::NOT_FOUND, "Stream token expired or invalid"))?;

    if relpath != "index.mpd" && relpath != "index.m3u8" {
        let base = url::Url::parse(&target.url)
            .map_err(|e| api_err(StatusCode::BAD_REQUEST, e.to_string()))?;
        let joined = base
            .join(&relpath)
            .map_err(|e| api_err(StatusCode::BAD_REQUEST, e.to_string()))?;
        target.url = joined.to_string();
    }

    let range = req_headers
        .get(header::RANGE)
        .and_then(|v| v.to_str().ok());

    let upstream = build_upstream_request(&state.http_client, &target, range)
        .send()
        .await
        .map_err(|e| api_err(StatusCode::BAD_GATEWAY, e.to_string()))?;

    let status = StatusCode::from_u16(upstream.status().as_u16()).unwrap_or(StatusCode::OK);
    let mut builder = Response::builder().status(status);

    for name in [
        header::CONTENT_TYPE,
        header::CONTENT_LENGTH,
        header::CONTENT_RANGE,
        header::ACCEPT_RANGES,
    ] {
        if let Some(val) = upstream.headers().get(&name) {
            builder = builder.header(name, val);
        }
    }

    let body = Body::from_stream(upstream.bytes_stream());
    builder
        .body(body)
        .map_err(|e| api_err(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))
}

pub async fn download(
    State(state): State<AppState>,
    Query(q): Query<StreamQuery>,
) -> Result<Response, ApiError> {
    let target = state
        .get_stream_target(&q.token)
        .await
        .ok_or_else(|| api_err(StatusCode::NOT_FOUND, "Download token expired or invalid"))?;

    let upstream = build_upstream_request(&state.http_client, &target, None)
        .send()
        .await
        .map_err(|e| api_err(StatusCode::BAD_GATEWAY, e.to_string()))?;

    let status = StatusCode::from_u16(upstream.status().as_u16()).unwrap_or(StatusCode::OK);
    let raw_name = q
        .filename
        .or_else(|| target.filename.clone())
        .unwrap_or_else(|| "movie.mp4".to_string());
    let safe_name: String = raw_name
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_' | ' ') { c } else { '_' })
        .collect();

    let mut builder = Response::builder()
        .status(status)
        .header(
            header::CONTENT_DISPOSITION,
            format!("attachment; filename=\"{safe_name}\""),
        );

    for name in [header::CONTENT_TYPE, header::CONTENT_LENGTH] {
        if let Some(val) = upstream.headers().get(&name) {
            builder = builder.header(name, val);
        }
    }

    let body = Body::from_stream(upstream.bytes_stream());
    builder
        .body(body)
        .map_err(|e| api_err(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))
}

#[derive(Deserialize)]
pub struct EdgeStreamQuery {
    pub u: String,
    pub h: Option<String>,
    pub n: Option<String>,
}

fn decode_b64url(input: &str) -> Result<Vec<u8>, ApiError> {
    use base64::Engine as _;
    base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(input.trim_end_matches('='))
        .map_err(|e| api_err(StatusCode::BAD_REQUEST, format!("Invalid base64: {e}")))
}

pub async fn edge_stream(
    State(state): State<AppState>,
    Query(q): Query<EdgeStreamQuery>,
    req_headers: HeaderMap,
) -> Result<Response, ApiError> {
    let url = String::from_utf8(decode_b64url(&q.u)?)
        .map_err(|e| api_err(StatusCode::BAD_REQUEST, e.to_string()))?;
    let headers: Vec<(String, String)> = match q.h.as_deref().filter(|s| !s.is_empty()) {
        Some(h_b64) => serde_json::from_slice(&decode_b64url(h_b64)?)
            .unwrap_or_default(),
        None => Vec::new(),
    };
    let target = StreamTarget {
        url,
        headers,
        filename: q.n,
        created_at: unix_now(),
    };
    let range = req_headers.get(header::RANGE).and_then(|v| v.to_str().ok());
    let upstream = build_upstream_request(&state.http_client, &target, range)
        .send()
        .await
        .map_err(|e| api_err(StatusCode::BAD_GATEWAY, e.to_string()))?;

    let status = StatusCode::from_u16(upstream.status().as_u16()).unwrap_or(StatusCode::OK);
    let mut builder = Response::builder().status(status);
    for name in [
        header::CONTENT_TYPE,
        header::CONTENT_LENGTH,
        header::CONTENT_RANGE,
        header::ACCEPT_RANGES,
    ] {
        if let Some(val) = upstream.headers().get(&name) {
            builder = builder.header(name, val);
        }
    }
    builder
        .body(Body::from_stream(upstream.bytes_stream()))
        .map_err(|e| api_err(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))
}

pub async fn edge_download(
    State(state): State<AppState>,
    Query(q): Query<EdgeStreamQuery>,
) -> Result<Response, ApiError> {
    let url = String::from_utf8(decode_b64url(&q.u)?)
        .map_err(|e| api_err(StatusCode::BAD_REQUEST, e.to_string()))?;
    let headers: Vec<(String, String)> = match q.h.as_deref().filter(|s| !s.is_empty()) {
        Some(h_b64) => serde_json::from_slice(&decode_b64url(h_b64)?)
            .unwrap_or_default(),
        None => Vec::new(),
    };
    let raw_name = q.n.unwrap_or_else(|| "movie.mp4".to_string());
    let safe_name: String = raw_name
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_' | ' ') { c } else { '_' })
        .collect();
    let target = StreamTarget {
        url,
        headers,
        filename: Some(safe_name.clone()),
        created_at: unix_now(),
    };
    let upstream = build_upstream_request(&state.http_client, &target, None)
        .send()
        .await
        .map_err(|e| api_err(StatusCode::BAD_GATEWAY, e.to_string()))?;

    let status = StatusCode::from_u16(upstream.status().as_u16()).unwrap_or(StatusCode::OK);
    let mut builder = Response::builder().status(status).header(
        header::CONTENT_DISPOSITION,
        format!("attachment; filename=\"{safe_name}\""),
    );
    for name in [header::CONTENT_TYPE, header::CONTENT_LENGTH] {
        if let Some(val) = upstream.headers().get(&name) {
            builder = builder.header(name, val);
        }
    }
    builder
        .body(Body::from_stream(upstream.bytes_stream()))
        .map_err(|e| api_err(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))
}

use std::collections::HashMap;
use std::sync::{LazyLock, Mutex};

static HLS_SESSIONS: LazyLock<Mutex<HashMap<String, std::sync::Arc<std::sync::atomic::AtomicU64>>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

pub async fn transcode_hls(
    State(state): State<AppState>,
    Path((u_b64, file)): Path<(String, String)>,
) -> Result<Response, ApiError> {
    use futures::StreamExt;
    use std::process::Stdio;
    use std::sync::Arc;
    use std::sync::atomic::{AtomicU64, Ordering};
    use tokio::io::AsyncWriteExt;
    use tokio::process::Command;

    if file.contains("..") || file.contains('/') || file.contains('\\') {
        return Err(api_err(StatusCode::BAD_REQUEST, "Invalid file path"));
    }

    let url = String::from_utf8(decode_b64url(&u_b64)?)
        .map_err(|e| api_err(StatusCode::BAD_REQUEST, e.to_string()))?;
    let session_id = &moviebox_tui::cache::md5_hex(&url)[..16];
    let dir = std::env::temp_dir().join("mbw-hls").join(session_id);
    let now = unix_now();

    let needs_spawn = {
        let mut map = HLS_SESSIONS.lock().unwrap();
        if let Some(last_access) = map.get(session_id) {
            last_access.store(now, Ordering::Relaxed);
            false
        } else {
            let tracker = Arc::new(AtomicU64::new(now));
            map.insert(session_id.to_string(), Arc::clone(&tracker));
            true
        }
    };

    if needs_spawn {
        let _ = tokio::fs::remove_dir_all(&dir).await;
        tokio::fs::create_dir_all(&dir)
            .await
            .map_err(|e| api_err(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

        let client = state.http_client.clone();
        let dir_clone = dir.clone();
        let sid_owned = session_id.to_string();
        let url_clone = url.clone();

        tokio::spawn(async move {
            let seg_pattern = dir_clone.join("seg_%03d.ts");
            let m3u8_path = dir_clone.join("index.m3u8");

            let mut child = match Command::new("ffmpeg")
                .args([
                    "-hide_banner",
                    "-loglevel",
                    "error",
                    "-i",
                    "pipe:0",
                    "-c:v",
                    "libx264",
                    "-preset",
                    "ultrafast",
                    "-tune",
                    "zerolatency",
                    "-crf",
                    "26",
                    "-vf",
                    "scale='min(1280,iw)':-2,format=yuv420p",
                    "-g",
                    "48",
                    "-sc_threshold",
                    "0",
                    "-c:a",
                    "aac",
                    "-b:a",
                    "128k",
                    "-f",
                    "hls",
                    "-hls_time",
                    "2",
                    "-hls_list_size",
                    "0",
                    "-hls_flags",
                    "independent_segments+temp_file",
                    "-hls_segment_filename",
                    seg_pattern.to_str().unwrap_or("seg_%03d.ts"),
                    m3u8_path.to_str().unwrap_or("index.m3u8"),
                ])
                .stdin(Stdio::piped())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .kill_on_drop(true)
                .spawn()
            {
                Ok(c) => c,
                Err(_) => {
                    HLS_SESSIONS.lock().unwrap().remove(&sid_owned);
                    return;
                }
            };

            let mut stdin = child.stdin.take().unwrap();
            let sid_for_pump = sid_owned.clone();

            let pump = async move {
                if let Ok(resp) = client
                    .get(&url_clone)
                    .header("User-Agent", moviebox_tui::net::APP_HTTP_USER_AGENT)
                    .send()
                    .await
                {
                    let mut stream = resp.bytes_stream();
                    while let Some(Ok(chunk)) = stream.next().await {
                        let last = HLS_SESSIONS
                            .lock()
                            .unwrap()
                            .get(&sid_for_pump)
                            .map(|a| a.load(Ordering::Relaxed))
                            .unwrap_or(0);
                        if unix_now().saturating_sub(last) > 45 {
                            break;
                        }
                        if stdin.write_all(&chunk).await.is_err() {
                            break;
                        }
                    }
                }
            };

            let _ = tokio::join!(pump, child.wait());
            HLS_SESSIONS.lock().unwrap().remove(&sid_owned);
            let _ = tokio::fs::remove_dir_all(&dir_clone).await;
        });
    }

    let target_file = dir.join(&file);
    for _ in 0..90 {
        if let Ok(bytes) = tokio::fs::read(&target_file).await
            && !bytes.is_empty()
        {
            let ct = if file.ends_with(".m3u8") {
                "application/vnd.apple.mpegurl"
            } else {
                "video/mp2t"
            };
            return Ok((
                StatusCode::OK,
                [
                    (header::CONTENT_TYPE, ct),
                    (header::CACHE_CONTROL, "no-store"),
                ],
                bytes,
            )
                .into_response());
        }
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    }

    Err(api_err(StatusCode::GATEWAY_TIMEOUT, "HLS segment timeout"))
}

pub async fn updater_status(State(state): State<AppState>) -> Json<crate::state::UpdateStatus> {
    let st = state.update_status.read().await.clone();
    Json(st)
}

pub async fn updater_check(State(state): State<AppState>) -> Json<serde_json::Value> {
    let res = updater::check_and_apply_update(state.clone()).await;
    let st = state.update_status.read().await.clone();
    match res {
        Ok(updated) => Json(serde_json::json!({
            "updated": updated,
            "status": st,
        })),
        Err(err) => Json(serde_json::json!({
            "updated": false,
            "error": err,
            "status": st,
        })),
    }
}

