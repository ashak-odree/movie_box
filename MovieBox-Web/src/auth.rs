use axum::{
    Json,
    extract::{Request, State},
    http::{StatusCode, header},
    middleware::Next,
    response::{IntoResponse, Response},
};
use axum_extra::extract::cookie::{Cookie, CookieJar, SameSite};
use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use hmac::{Hmac, KeyInit, Mac};
use serde::{Deserialize, Serialize};
use sha2::Sha256;

use crate::state::{AppState, unix_now};

type HmacSha256 = Hmac<Sha256>;

const SESSION_COOKIE_NAME: &str = "mb_session";
const SESSION_TTL_SECS: u64 = 7 * 24 * 3600;

#[derive(Deserialize)]
pub struct LoginRequest {
    pub passcode: String,
}

#[derive(Serialize)]
pub struct AuthResponse {
    pub authenticated: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

fn sign_session(secret: &[u8; 32], issued_at: u64) -> String {
    let payload = issued_at.to_string();
    let mut mac = HmacSha256::new_from_slice(secret).expect("HMAC key size is valid");
    mac.update(payload.as_bytes());
    let sig = URL_SAFE_NO_PAD.encode(mac.finalize().into_bytes());
    format!("{payload}.{sig}")
}

fn verify_session(secret: &[u8; 32], token: &str) -> bool {
    let Some((payload, sig_b64)) = token.split_once('.') else {
        return false;
    };
    let Ok(issued_at) = payload.parse::<u64>() else {
        return false;
    };
    if unix_now().saturating_sub(issued_at) > SESSION_TTL_SECS {
        return false;
    }
    let Ok(sig_bytes) = URL_SAFE_NO_PAD.decode(sig_b64) else {
        return false;
    };
    let mut mac = HmacSha256::new_from_slice(secret).expect("HMAC key size is valid");
    mac.update(payload.as_bytes());
    mac.verify_slice(&sig_bytes).is_ok()
}

pub fn is_authenticated(state: &AppState, jar: &CookieJar, headers: &axum::http::HeaderMap) -> bool {
    if let Some(cookie) = jar.get(SESSION_COOKIE_NAME)
        && verify_session(&state.hmac_secret, cookie.value())
    {
        return true;
    }

    if let Some(auth_hdr) = headers.get(header::AUTHORIZATION).and_then(|v| v.to_str().ok())
        && let Some(token) = auth_hdr.strip_prefix("Bearer ")
        && token.trim() == state.config.passcode
    {
        return true;
    }

    false
}

pub async fn login(
    State(state): State<AppState>,
    jar: CookieJar,
    Json(req): Json<LoginRequest>,
) -> impl IntoResponse {
    if req.passcode.trim() != state.config.passcode {
        return (
            StatusCode::UNAUTHORIZED,
            jar,
            Json(AuthResponse {
                authenticated: false,
                error: Some("Access denied: wrong passphrase".to_string()),
            }),
        );
    }

    let token = sign_session(&state.hmac_secret, unix_now());
    let cookie = Cookie::build((SESSION_COOKIE_NAME, token))
        .path("/")
        .http_only(true)
        .same_site(SameSite::Lax)
        .max_age(time::Duration::seconds(SESSION_TTL_SECS as i64))
        .build();

    (
        StatusCode::OK,
        jar.add(cookie),
        Json(AuthResponse {
            authenticated: true,
            error: None,
        }),
    )
}

pub async fn logout(jar: CookieJar) -> impl IntoResponse {
    let removal = Cookie::build((SESSION_COOKIE_NAME, ""))
        .path("/")
        .http_only(true)
        .same_site(SameSite::Lax)
        .max_age(time::Duration::ZERO)
        .build();

    (
        StatusCode::OK,
        jar.add(removal),
        Json(AuthResponse {
            authenticated: false,
            error: None,
        }),
    )
}

pub async fn check(
    State(state): State<AppState>,
    jar: CookieJar,
    headers: axum::http::HeaderMap,
) -> Json<AuthResponse> {
    Json(AuthResponse {
        authenticated: is_authenticated(&state, &jar, &headers),
        error: None,
    })
}

pub async fn require_auth(
    State(state): State<AppState>,
    jar: CookieJar,
    request: Request,
    next: Next,
) -> Result<Response, (StatusCode, Json<AuthResponse>)> {
    if is_authenticated(&state, &jar, request.headers()) {
        Ok(next.run(request).await)
    } else {
        Err((
            StatusCode::UNAUTHORIZED,
            Json(AuthResponse {
                authenticated: false,
                error: Some("Authentication required".to_string()),
            }),
        ))
    }
}

