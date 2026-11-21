mod api;
mod auth;
mod state;
mod updater;

use axum::{
    Json, Router,
    http::{StatusCode, header},
    middleware,
    response::Html,
    routing::{get, post},
};
use tower_http::cors::{Any, CorsLayer};

use crate::state::{AppConfig, AppState};

const INDEX_HTML: &str = include_str!("../web/index.html");
const STYLE_CSS: &str = include_str!("../web/style.css");
const APP_JS: &str = include_str!("../web/app.js");

async fn index_handler() -> Html<&'static str> {
    Html(INDEX_HTML)
}

async fn css_handler() -> (StatusCode, [(header::HeaderName, &'static str); 1], &'static str) {
    (
        StatusCode::OK,
        [(header::CONTENT_TYPE, "text/css; charset=utf-8")],
        STYLE_CSS,
    )
}

async fn js_handler() -> (StatusCode, [(header::HeaderName, &'static str); 1], &'static str) {
    (
        StatusCode::OK,
        [(header::CONTENT_TYPE, "application/javascript; charset=utf-8")],
        APP_JS,
    )
}

async fn health() -> Json<serde_json::Value> {
    Json(serde_json::json!({ "ok": true }))
}

#[tokio::main]
async fn main() {
    env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("info")).init();

    let config = AppConfig::from_env();
    let port = config.port;
    let state = AppState::new(config);

    tokio::spawn(updater::run_scheduler(state.clone()));

    let protected_api = Router::new()
        .route("/providers", get(api::providers))
        .route("/homepage", get(api::homepage))
        .route("/search", get(api::search))
        .route("/suggest", get(api::suggest))
        .route("/details", get(api::details))
        .route("/streams", get(api::streams))
        .route("/resolve", post(api::resolve))
        .route("/captions", get(api::captions))
        .route("/poster", get(api::poster))
        .route("/stream", get(api::stream))
        .route("/edge-stream", get(api::edge_stream))
        .route("/edge-download", get(api::edge_download))
        .route("/transcode", get(api::transcode))
        .route("/manifest/{token}/{*relpath}", get(api::stream_manifest_segment))
        .route("/download", get(api::download))
        .route("/updater/status", get(api::updater_status))
        .route("/updater/check", post(api::updater_check))
        .layer(middleware::from_fn_with_state(
            state.clone(),
            auth::require_auth,
        ));

    let auth_api = Router::new()
        .route("/login", post(auth::login))
        .route("/logout", post(auth::logout))
        .route("/check", get(auth::check));

    let cors = CorsLayer::new()
        .allow_origin(Any)
        .allow_methods(Any)
        .allow_headers(Any);

    let app = Router::new()
        .route("/", get(index_handler))
        .route("/style.css", get(css_handler))
        .route("/app.js", get(js_handler))
        .route("/api/health", get(health))
        .nest("/api/auth", auth_api)
        .nest("/api", protected_api)
        .layer(cors)
        .with_state(state);

    let addr = format!("0.0.0.0:{port}");
    log::info!("MovieBox-Web listening on http://{addr}");
    let listener = tokio::net::TcpListener::bind(&addr)
        .await
        .expect("Failed to bind port");

    axum::serve(listener, app).await.expect("Server error");
}

