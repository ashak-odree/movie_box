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
                let mut res_items = moviebox_resource_json_to_releases(&payload);
                if season > 0 || episode > 0 {
                    res_items.retain(|r| {
                        r.season.unwrap_or(season) == season
                            && r.episode.unwrap_or(episode) == episode
                    });
                }
                list.extend(res_items);
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
    let needs_cookie_proxy = target_headers
        .iter()
        .any(|(k, _)| k.eq_ignore_ascii_case("cookie"));

    // If no Cookie header is required and it's a direct video file (not DASH/HLS),
    // return the direct CDN URL so the browser streams/downloads at 100% CDN speed
    // without any extra redirect or tunnel hop!
    if !needs_cookie_proxy && !is_dash && !is_hls {
        return Ok(Json(ResolveResponse {
            stream_url: target_url.clone(),
            download_url: target_url,
            is_hls,
            is_dash,
            filename,
        }));
    }

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

    if q.vtt != Some(1) && target.headers.is_empty() {
        return Ok(axum::response::Redirect::temporary(&target.url).into_response());
    }

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

    if target.headers.is_empty() {
        return Ok(axum::response::Redirect::temporary(&target.url).into_response());
    }

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

