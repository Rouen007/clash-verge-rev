use std::sync::atomic::{AtomicBool, Ordering};

use clash_verge_logging::{Type, logging};
use tokio::time::{Duration, sleep};

use crate::{
    config::Config,
    core::{handle::Handle, tray::Tray},
    process::AsyncHandler,
};

const DEFAULT_INTERVAL_SECS: u64 = 15;
const MIN_INTERVAL_SECS: u64 = 10;
const MAX_INTERVAL_SECS: u64 = 300;
const FAILURE_THRESHOLD: u8 = 3;
const TEST_TIMEOUT_MS: u32 = 5_000;
const DEFAULT_TEST_URL: &str = "https://www.tradingview.com/";
const DEFAULT_GROUP: &str = "GLOBAL";

static STARTED: AtomicBool = AtomicBool::new(false);

#[derive(Debug)]
struct Settings {
    enabled: bool,
    interval: Duration,
    test_url: String,
    group: String,
}

pub async fn init() {
    if STARTED.swap(true, Ordering::AcqRel) {
        return;
    }

    AsyncHandler::spawn(|| async {
        let mut failures: u8 = 0;

        loop {
            if Handle::global().is_exiting() {
                break;
            }

            let settings = settings().await;
            if !settings.enabled {
                failures = 0;
                sleep(Duration::from_secs(MIN_INTERVAL_SECS)).await;
                continue;
            }

            if probe(&settings.group, &settings.test_url).await {
                failures = 0;
            } else {
                failures = failures.saturating_add(1);
                logging!(
                    warn,
                    Type::Core,
                    "[AutoFailover] {} connectivity check failed ({}/{})",
                    settings.group,
                    failures,
                    FAILURE_THRESHOLD
                );

                if failures >= FAILURE_THRESHOLD {
                    if let Err(err) = switch_to_next_healthy(&settings).await {
                        logging!(error, Type::Core, "[AutoFailover] failover failed: {err:#}");
                    }
                    failures = 0;
                }
            }

            sleep(settings.interval).await;
        }

        STARTED.store(false, Ordering::Release);
    });
}

async fn settings() -> Settings {
    let verge = Config::verge().await;
    let verge = verge.latest_arc();
    let interval_secs = verge
        .auto_failover_interval_seconds
        .unwrap_or(DEFAULT_INTERVAL_SECS)
        .clamp(MIN_INTERVAL_SECS, MAX_INTERVAL_SECS);

    Settings {
        enabled: verge.enable_auto_failover.unwrap_or(false),
        interval: Duration::from_secs(interval_secs),
        test_url: verge
            .auto_failover_test_url
            .clone()
            .map(|value| value.to_string())
            .unwrap_or_else(|| DEFAULT_TEST_URL.into()),
        group: verge
            .auto_failover_group
            .clone()
            .map(|value| value.to_string())
            .unwrap_or_else(|| DEFAULT_GROUP.into()),
    }
}

async fn probe(proxy_name: &str, test_url: &str) -> bool {
    let result = {
        let mihomo = Handle::mihomo().await;
        mihomo.delay_proxy_by_name(proxy_name, test_url, TEST_TIMEOUT_MS).await
    };

    result.is_ok_and(|response| response.delay > 0)
}

async fn switch_to_next_healthy(settings: &Settings) -> anyhow::Result<()> {
    let proxies = {
        let mihomo = Handle::mihomo().await;
        mihomo.get_proxies().await?
    };
    let group = proxies
        .proxies
        .get(&settings.group)
        .ok_or_else(|| anyhow::anyhow!("proxy group {} not found", settings.group))?;
    let current = group.now.as_deref();
    let mut candidates = group.all.clone().unwrap_or_default();
    candidates.sort_by_key(|name| region_priority(name));

    if candidates.len() < 2 {
        anyhow::bail!("proxy group {} has no fallback candidates", settings.group);
    }

    let start = current
        .and_then(|name| candidates.iter().position(|candidate| candidate == name))
        .map(|index| (index + 1) % candidates.len())
        .unwrap_or(0);

    for offset in 0..candidates.len() {
        let candidate = &candidates[(start + offset) % candidates.len()];
        if current.is_some_and(|name| name == candidate) || !probe(candidate, &settings.test_url).await {
            continue;
        }

        {
            let mihomo = Handle::mihomo().await;
            mihomo.select_node_for_group(&settings.group, candidate).await?;
        }

        logging!(
            warn,
            Type::Core,
            "[AutoFailover] {} -> {} after {} failed connectivity checks",
            settings.group,
            candidate,
            FAILURE_THRESHOLD
        );
        Handle::refresh_clash();
        let _ = Tray::global().update_menu().await;
        return Ok(());
    }

    anyhow::bail!("no healthy fallback node available for {}", settings.group)
}

fn region_priority(name: &str) -> u8 {
    let uppercase = name.to_ascii_uppercase();
    if uppercase.contains("JP") || name.contains("日本") || uppercase.contains("JAPAN") {
        0
    } else if uppercase.contains("SG") || name.contains("新加坡") || uppercase.contains("SINGAPORE") {
        1
    } else if uppercase.contains("TW") || name.contains("台湾") || uppercase.contains("TAIWAN") {
        2
    } else if uppercase.contains("US") || name.contains("美国") || uppercase.contains("UNITED STATES") {
        3
    } else {
        4
    }
}

#[cfg(test)]
mod tests {
    use super::region_priority;

    #[test]
    fn sorts_preferred_regions_first() {
        assert!(region_priority("JP") < region_priority("SG"));
        assert!(region_priority("SG") < region_priority("TW"));
        assert!(region_priority("TW") < region_priority("US"));
    }
}
