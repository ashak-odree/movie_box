use std::path::Path;
use std::process::Stdio;
use std::time::Duration;

use tokio::process::Command;

use crate::state::{AppState, unix_now};

async fn run_cmd(cwd: &Path, program: &str, args: &[&str]) -> Result<String, String> {
    let output = Command::new(program)
        .args(args)
        .current_dir(cwd)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .await
        .map_err(|e| format!("Failed to spawn {program}: {e}"))?;

    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();

    if output.status.success() {
        Ok(stdout)
    } else {
        Err(if stderr.is_empty() { stdout } else { stderr })
    }
}

pub async fn refresh_current_commit(state: &AppState) {
    if let Ok(hash) = run_cmd(&state.config.tui_repo_dir, "git", &["rev-parse", "--short", "HEAD"]).await {
        let mut st = state.update_status.write().await;
        st.current_commit = Some(hash);
    }
}

pub async fn check_and_apply_update(state: AppState) -> Result<bool, String> {
    let tui_dir = &state.config.tui_repo_dir;
    let web_dir = &state.config.web_repo_dir;

    {
        let mut st = state.update_status.write().await;
        st.state = "checking".to_string();
        st.last_error = None;
    }

    let current = run_cmd(tui_dir, "git", &["rev-parse", "--short", "HEAD"])
        .await
        .ok();

    if let Err(err) = run_cmd(tui_dir, "git", &["fetch", "origin"]).await {
        let mut st = state.update_status.write().await;
        st.current_commit = current;
        st.last_checked_unix = Some(unix_now());
        st.state = "error".to_string();
        st.last_error = Some(format!("git fetch failed: {err}"));
        return Err(err);
    }

    let behind_count = run_cmd(tui_dir, "git", &["rev-list", "--count", "HEAD..@{u}"])
        .await
        .unwrap_or_else(|_| "0".to_string())
        .parse::<u64>()
        .unwrap_or(0);

    let remote = run_cmd(tui_dir, "git", &["rev-parse", "--short", "@{u}"])
        .await
        .ok();

    if behind_count == 0 {
        let mut st = state.update_status.write().await;
        st.current_commit = current;
        st.remote_commit = remote;
        st.last_checked_unix = Some(unix_now());
        st.state = "up_to_date".to_string();
        return Ok(false);
    }

    log::info!(
        "MovieBox-TUI update detected ({behind_count} new commit(s)); pulling and rebuilding..."
    );

    {
        let mut st = state.update_status.write().await;
        st.current_commit = current;
        st.remote_commit = remote.clone();
        st.state = "pulling".to_string();
    }

    if let Err(err) = run_cmd(tui_dir, "git", &["pull", "--ff-only"]).await {
        let mut st = state.update_status.write().await;
        st.last_checked_unix = Some(unix_now());
        st.state = "error".to_string();
        st.last_error = Some(format!("git pull failed: {err}"));
        return Err(err);
    }

    {
        let mut st = state.update_status.write().await;
        st.state = "building".to_string();
    }

    if let Err(err) = run_cmd(web_dir, "cargo", &["build", "--release"]).await {
        let mut st = state.update_status.write().await;
        st.last_checked_unix = Some(unix_now());
        st.state = "error".to_string();
        st.last_error = Some(format!("cargo build failed: {err}"));
        return Err(err);
    }

    let new_commit = run_cmd(tui_dir, "git", &["rev-parse", "--short", "HEAD"])
        .await
        .ok();

    {
        let mut st = state.update_status.write().await;
        st.current_commit = new_commit;
        st.remote_commit = remote;
        st.last_checked_unix = Some(unix_now());
        st.state = "restarting".to_string();
    }

    let exit_code = state.config.restart_exit_code;
    tokio::spawn(async move {
        tokio::time::sleep(Duration::from_secs(1)).await;
        log::info!("Exiting with code {exit_code} to restart with updated MovieBox-TUI...");
        std::process::exit(exit_code);
    });

    Ok(true)
}

pub async fn run_scheduler(state: AppState) {
    refresh_current_commit(&state).await;

    if !state.config.auto_update_enabled {
        log::info!("Auto-update scheduler is disabled.");
        return;
    }

    let interval_secs = state.config.auto_update_interval_secs;
    log::info!(
        "Auto-update scheduler started (checking {} every {}s)",
        state.config.tui_repo_dir.display(),
        interval_secs
    );

    let mut ticker = tokio::time::interval(Duration::from_secs(interval_secs));
    // Skip immediate tick on startup so boot is fast; first check runs after 30s
    ticker.tick().await;
    tokio::time::sleep(Duration::from_secs(30)).await;
    let _ = check_and_apply_update(state.clone()).await;

    loop {
        ticker.tick().await;
        if let Err(e) = check_and_apply_update(state.clone()).await {
            log::warn!("Scheduled update check failed: {e}");
        }
    }
}

