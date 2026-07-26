//! macOS startup checks for TUN ownership and routing.
//!
//! A persisted `enable_tun_mode` flag is not proof that mihomo successfully
//! created its utun device. Another VPN/TUN client can leave a conflicting
//! route behind, so startup must validate the effective kernel state.

use crate::{config::Config, core::handle::Handle};
use anyhow::{Context, Result, bail};
use clash_verge_logging::{Type, logging};
use std::time::Duration;
use tokio::{process::Command, time::sleep};

const TUN_READY_RETRIES: usize = 10;
const TUN_READY_RETRY_DELAY: Duration = Duration::from_millis(500);

/// Verify that Clash's macOS TUN is actually present and owns the default route.
///
/// This is intentionally observational: we do not kill another VPN/TUN client
/// because an arbitrary `utun` may belong to iCloud Private Relay, WireGuard,
/// another VPN, or the user's other network tools.
pub async fn verify_tun_ready() -> Result<()> {
    if !Config::verge().await.latest_arc().enable_tun_mode.unwrap_or(false) {
        return Ok(());
    }

    for attempt in 1..=TUN_READY_RETRIES {
        let ifconfig = command_output("/sbin/ifconfig", &[]).await?;
        let route = command_output("/sbin/route", &["-n", "get", "default"]).await?;

        let has_clash_tun = has_clash_tun_interface(&ifconfig);
        let default_route_is_tun = route
            .lines()
            .any(|line| line.trim_start().starts_with("interface:") && line.contains("utun"));

        if has_clash_tun && default_route_is_tun {
            logging!(
                info,
                Type::Setup,
                "macOS TUN startup check passed: Clash utun is present and owns the default route"
            );
            return Ok(());
        }

        logging!(
            debug,
            Type::Setup,
            "macOS TUN startup check {attempt}/{TUN_READY_RETRIES}: clash_utun={has_clash_tun}, default_route_is_utun={default_route_is_tun}"
        );
        sleep(TUN_READY_RETRY_DELAY).await;
    }

    let message = "Clash TUN 已开启，但启动后未确认自己的 utun 和默认路由生效；可能与其他 VPN/TUN 客户端冲突";
    Handle::notice_message("tun::startup_check_failed", message);
    bail!("{message}")
}

async fn command_output(program: &str, args: &[&str]) -> Result<String> {
    let output = Command::new(program)
        .args(args)
        .output()
        .await
        .with_context(|| format!("failed to run {program}"))?;

    if !output.status.success() {
        bail!("{program} exited with status {}", output.status.code().unwrap_or(-1));
    }

    Ok(String::from_utf8_lossy(&output.stdout).into_owned())
}

fn has_clash_tun_interface(ifconfig: &str) -> bool {
    let mut in_utun = false;
    let mut has_clash_address = false;

    for line in ifconfig.lines() {
        if !line.starts_with(' ') && !line.starts_with('\t') {
            if in_utun && has_clash_address {
                return true;
            }
            in_utun = line.starts_with("utun");
            has_clash_address = false;
        } else if in_utun && line.contains("inet 198.18.0.") {
            has_clash_address = true;
        }
    }

    in_utun && has_clash_address
}

#[cfg(test)]
mod tests {
    use super::has_clash_tun_interface;

    #[test]
    fn recognizes_clash_utun_address() {
        let ifconfig = "utun11: flags=8051<UP>\n\tinet 198.18.0.1 --> 198.18.0.1 netmask 0xfffffffc\n";
        assert!(has_clash_tun_interface(ifconfig));
    }

    #[test]
    fn ignores_non_clash_utun_address() {
        let ifconfig = "utun3: flags=8051<UP>\n\tinet 10.0.0.2 --> 10.0.0.1 netmask 0xffffff00\n";
        assert!(!has_clash_tun_interface(ifconfig));
    }
}
