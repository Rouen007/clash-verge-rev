use clash_verge_logging::{Type, logging};

pub async fn set_public_dns(dns_server: String) {
    use crate::{core::handle, utils::dirs};
    use tauri_plugin_shell::ShellExt as _;
    let app_handle = handle::Handle::app_handle();

    logging!(info, Type::Config, "try to set system dns");
    let resource_dir = match dirs::app_resources_dir() {
        Ok(dir) => dir,
        Err(e) => {
            logging!(error, Type::Config, "Failed to get resource directory: {}", e);
            return;
        }
    };
    let script = resource_dir.join("set_dns.sh");
    if !script.exists() {
        logging!(error, Type::Config, "set_dns.sh not found");
        return;
    }
    let script = script.to_string_lossy().into_owned();
    match app_handle
        .shell()
        .command("bash")
        .args([script, dns_server])
        .current_dir(resource_dir)
        .status()
        .await
    {
        Ok(status) => {
            if status.success() {
                logging!(info, Type::Config, "set system dns successfully");
            } else {
                let code = status.code().unwrap_or(-1);
                logging!(error, Type::Config, "set system dns failed: {code}");
            }
        }
        Err(err) => {
            logging!(error, Type::Config, "set system dns failed: {err}");
        }
    }
}

#[cfg(target_os = "macos")]
pub async fn restore_public_dns() -> bool {
    use crate::{core::handle, utils::dirs};
    use tauri_plugin_shell::ShellExt as _;
    let app_handle = handle::Handle::app_handle();
    logging!(info, Type::Config, "try to unset system dns");
    let resource_dir = match dirs::app_resources_dir() {
        Ok(dir) => dir,
        Err(e) => {
            logging!(error, Type::Config, "Failed to get resource directory: {}", e);
            return false;
        }
    };
    let script = resource_dir.join("unset_dns.sh");
    if !script.exists() {
        logging!(error, Type::Config, "unset_dns.sh not found");
        return false;
    }
    let script = script.to_string_lossy().into_owned();
    match app_handle
        .shell()
        .command("bash")
        .args([script])
        .current_dir(resource_dir)
        .status()
        .await
    {
        Ok(status) => {
            if status.success() {
                logging!(info, Type::Config, "unset system dns successfully");
                true
            } else {
                let code = status.code().unwrap_or(-1);
                logging!(error, Type::Config, "unset system dns failed: {code}");
                false
            }
        }
        Err(err) => {
            logging!(error, Type::Config, "unset system dns failed: {err}");
            false
        }
    }
}

#[cfg(target_os = "macos")]
pub async fn restore_stale_dns_on_startup() -> bool {
    use crate::utils::dirs;

    let resource_dir = match dirs::app_resources_dir() {
        Ok(dir) => dir,
        Err(e) => {
            logging!(error, Type::Setup, "Failed to get resource directory: {}", e);
            return false;
        }
    };
    if !resource_dir.join(".original_dns.txt").exists() {
        return true;
    }

    logging!(warn, Type::Setup, "发现上次异常退出留下的 DNS 备份，启动时恢复");
    restore_public_dns().await
}
