use crate::config::Config;
use crate::core::{CoreManager, handle, sysopt};
use crate::module::lightweight;
use crate::utils;
use crate::utils::window_manager::WindowManager;
use clash_verge_logging::{Type, logging};
use tokio::time::{Duration, sleep, timeout};

pub async fn open_or_close_dashboard() {
    if lightweight::is_in_lightweight_mode() {
        let _ = lightweight::exit_lightweight_mode().await;
        return;
    }

    let result = WindowManager::toggle_main_window().await;
    logging!(info, Type::Window, "Window toggle result: {result:?}");
}

pub async fn quit() {
    logging!(debug, Type::System, "启动退出流程");
    // 设置退出标志
    handle::Handle::global().set_is_exiting();

    utils::server::shutdown_embedded_server();
    Config::apply_all_and_save_file().await;

    logging!(info, Type::System, "开始异步清理资源");
    let cleanup_result = clean_async().await;

    logging!(
        info,
        Type::System,
        "资源清理完成，退出代码: {}",
        if cleanup_result { 0 } else { 1 }
    );

    let app_handle = handle::Handle::app_handle();
    app_handle.exit(if cleanup_result { 0 } else { 1 });
}

pub async fn clean_async() -> bool {
    logging!(info, Type::System, "开始执行异步清理操作...");
    // 必须串行：TUN 关闭/核心停止后再恢复 DNS，避免状态被再次覆盖。
    let core_success = disable_tun_and_stop_core().await;
    let proxy_success = reset_system_proxy().await;
    let dns_success = restore_dns_with_retry().await;

    let all_success = proxy_success && core_success && dns_success;

    logging!(
        info,
        Type::System,
        "异步关闭操作完成 - 代理: {}, 核心: {}, DNS: {}, 总体: {}",
        proxy_success,
        core_success,
        dns_success,
        all_success
    );

    all_success
}

async fn disable_tun_and_stop_core() -> bool {
    logging!(info, Type::System, "disable tun");
    let tun_enabled = Config::verge().await.data_arc().enable_tun_mode.unwrap_or(false);
    let mut success = true;
    if tun_enabled {
        let disable_tun = serde_json::json!({ "tun": { "enable": false } });
        match timeout(
            Duration::from_millis(1500),
            handle::Handle::mihomo().await.patch_base_config(&disable_tun),
        )
        .await
        {
            Ok(Ok(_)) => logging!(info, Type::Window, "TUN模式已禁用"),
            Ok(Err(e)) => {
                logging!(warn, Type::Window, "Warning: 禁用TUN模式失败: {e}");
                success = false;
            }
            Err(_) => {
                logging!(warn, Type::Window, "Warning: 禁用TUN模式超时");
                success = false;
            }
        }
    }

    #[cfg(target_os = "windows")]
    let stop_timeout = Duration::from_secs(2);
    #[cfg(not(target_os = "windows"))]
    let stop_timeout = Duration::from_secs(3);

    match timeout(stop_timeout, CoreManager::global().stop_core()).await {
        Ok(_) => success,
        Err(_) => {
            logging!(warn, Type::Window, "Warning: 停止core超时");
            false
        }
    }
}

async fn reset_system_proxy() -> bool {
    let sys_proxy_enabled = Config::verge().await.data_arc().enable_system_proxy.unwrap_or(false);
    if !sys_proxy_enabled {
        logging!(info, Type::Window, "系统代理未启用，跳过重置");
        return true;
    }
    match timeout(Duration::from_millis(1500), sysopt::Sysopt::global().reset_sysproxy()).await {
        Ok(Ok(_)) => {
            logging!(info, Type::Window, "系统代理已重置");
            true
        }
        Ok(Err(e)) => {
            logging!(warn, Type::Window, "Warning: 重置系统代理失败: {e}");
            false
        }
        Err(_) => {
            logging!(warn, Type::Window, "Warning: 重置系统代理超时");
            false
        }
    }
}

async fn restore_dns_with_retry() -> bool {
    #[cfg(target_os = "macos")]
    {
        for attempt in 1..=3 {
            if timeout(Duration::from_secs(2), crate::utils::resolve::dns::restore_public_dns())
                .await
                .unwrap_or(false)
            {
                logging!(info, Type::Window, "DNS设置已恢复（第{attempt}次尝试）");
                return true;
            }
            sleep(Duration::from_millis(250)).await;
        }
        logging!(warn, Type::Window, "Warning: DNS恢复失败，启动时将再次尝试");
        false
    }
    #[cfg(not(target_os = "macos"))]
    true
}

#[cfg(target_os = "macos")]
pub async fn hide() {
    use crate::module::lightweight::add_light_weight_timer;

    let enable_auto_light_weight_mode = Config::verge()
        .await
        .data_arc()
        .enable_auto_light_weight_mode
        .unwrap_or(false);

    if enable_auto_light_weight_mode {
        add_light_weight_timer().await;
    }

    if let Some(window) = WindowManager::get_main_window()
        && window.is_visible().unwrap_or(false)
    {
        let _ = window.hide();
    }
    handle::Handle::global().set_activation_policy_accessory();
}
