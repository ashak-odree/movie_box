use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use moviebox_tui::service::MovieBoxService;
use tokio::sync::RwLock;

#[derive(Clone, Debug)]
pub struct AppConfig {
    pub port: u16,
    pub passcode: String,
    pub tui_repo_dir: PathBuf,
    pub web_repo_dir: PathBuf,
    pub auto_update_enabled: bool,
    pub auto_update_interval_secs: u64,
    pub restart_exit_code: i32,
}

impl AppConfig {
    pub fn from_env() -> Self {
        let port = std::env::var("PORT")
            .ok()
            .and_then(|v| v.parse().ok())
            .unwrap_or(8080);

        let passcode = std::env::var("PASSCODE")
            .ok()
            .filter(|v| !v.trim().is_empty())
            .unwrap_or_else(|| "mamamiakoi".to_string());

        let tui_repo_dir = std::env::var("MOVIEBOX_TUI_DIR")
            .map(PathBuf::from)
            .unwrap_or_else(|_| PathBuf::from("../MovieBox-TUI"));

        let web_repo_dir = std::env::var("MOVIEBOX_WEB_DIR")
            .map(PathBuf::from)
            .unwrap_or_else(|_| PathBuf::from("."));

        let auto_update_enabled = std::env::var("AUTO_UPDATE_ENABLED")
            .map(|v| !matches!(v.to_ascii_lowercase().as_str(), "0" | "false" | "no"))
            .unwrap_or(true);

        let auto_update_interval_secs = std::env::var("AUTO_UPDATE_INTERVAL_SECS")
            .ok()
            .and_then(|v| v.parse().ok())
            .filter(|&v| v >= 60)
            .unwrap_or(1800);

        Self {
            port,
            passcode,
            tui_repo_dir,
            web_repo_dir,
            auto_update_enabled,
            auto_update_interval_secs,
            restart_exit_code: 42,
        }
    }
}

#[derive(Clone, Debug)]
pub struct StreamTarget {
    pub url: String,
    pub headers: Vec<(String, String)>,
    pub filename: Option<String>,
    pub created_at: u64,
}

#[derive(Clone, Debug, serde::Serialize)]
pub struct UpdateStatus {
    pub enabled: bool,
    pub interval_secs: u64,
    pub current_commit: Option<String>,
    pub remote_commit: Option<String>,
    pub last_checked_unix: Option<u64>,
    pub state: String,
    pub last_error: Option<String>,
}

#[derive(Clone)]
pub struct AppState {
    pub config: AppConfig,
    pub service: MovieBoxService,
    pub http_client: reqwest::Client,
    pub hmac_secret: [u8; 32],
    pub stream_tokens: Arc<RwLock<HashMap<String, StreamTarget>>>,
    pub update_status: Arc<RwLock<UpdateStatus>>,
}

impl AppState {
    pub fn new(config: AppConfig) -> Self {
        let mut hmac_secret = [0u8; 32];
        rand::fill(&mut hmac_secret);

        let http_client = moviebox_tui::net::http_client_builder()
            .connect_timeout(std::time::Duration::from_secs(10))
            .tcp_nodelay(true)
            .pool_max_idle_per_host(16)
            .build()
            .unwrap_or_default();

        let update_status = UpdateStatus {
            enabled: config.auto_update_enabled,
            interval_secs: config.auto_update_interval_secs,
            current_commit: None,
            remote_commit: None,
            last_checked_unix: None,
            state: if config.auto_update_enabled {
                "idle".to_string()
            } else {
                "disabled".to_string()
            },
            last_error: None,
        };

        Self {
            config,
            service: MovieBoxService::new(),
            http_client,
            hmac_secret,
            stream_tokens: Arc::new(RwLock::new(HashMap::new())),
            update_status: Arc::new(RwLock::new(update_status)),
        }
    }

    pub async fn register_stream_target(&self, target: StreamTarget) -> String {
        let mut bytes = [0u8; 16];
        rand::fill(&mut bytes);
        let token: String = bytes.iter().map(|b| format!("{b:02x}")).collect();

        let mut map = self.stream_tokens.write().await;
        if map.len() > 500 {
            let now = unix_now();
            map.retain(|_, v| now.saturating_sub(v.created_at) < 3600 * 6);
            if map.len() > 500 {
                map.clear();
            }
        }
        map.insert(token.clone(), target);
        token
    }

    pub async fn get_stream_target(&self, token: &str) -> Option<StreamTarget> {
        self.stream_tokens.read().await.get(token).cloned()
    }
}

pub fn unix_now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

