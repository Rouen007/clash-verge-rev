use super::CmdResult;
use crate::{
    cmd::StringifyErr as _,
    cmd::validate::{ValidationNoticeTarget, handle_validation_notice},
    config::{Config, IProfiles, PrfItem},
    core::{
        CoreManager, handle,
        validate::{CoreConfigValidator, ValidationOutcome},
    },
    module::auto_backup::{AutoBackupManager, AutoBackupTrigger},
    utils::dirs,
};
use clash_verge_logging::{Type, logging};
use serde::Deserialize;
use smartstring::alias::String;
use std::collections::HashSet;
use tokio::fs;

#[derive(Debug, Deserialize)]
pub struct ProfileFilePatch {
    pub index: std::string::String,
    pub file_data: std::string::String,
}

struct PreparedProfilePatch {
    patch: ProfileFilePatch,
    path: std::path::PathBuf,
    original_content: String,
    is_merge: bool,
    is_script: bool,
}

/// 保存profiles的配置
#[tauri::command]
pub async fn save_profile_file(index: String, file_data: Option<String>) -> CmdResult<ValidationOutcome> {
    let file_data = match file_data {
        Some(d) => d,
        None => return Ok(ValidationOutcome::Valid),
    };

    let backup_trigger = match index.as_str() {
        "Merge" => Some(AutoBackupTrigger::GlobalMerge),
        "Script" => Some(AutoBackupTrigger::GlobalScript),
        _ => None,
    };

    // 在异步操作前获取必要元数据并释放锁
    let (rel_path, is_merge_file, is_script_file, affects_runtime) = {
        let profiles = Config::profiles().await;
        let profiles_guard = profiles.latest_arc();
        let item = profiles_guard.get_item(&index).stringify_err()?;
        let is_merge = item.itype.as_ref().is_some_and(|t| t == "merge");
        let path = item.file.clone().ok_or("file field is null")?;
        let is_script = item.itype.as_ref().is_some_and(|t| t == "script") || path.ends_with(".js");
        let affects_runtime = profile_affects_runtime(&profiles_guard, &index);
        (path, is_merge, is_script, affects_runtime)
    };

    // 读取原始内容（在释放profiles_guard后进行）
    let original_content = PrfItem {
        file: Some(rel_path.clone()),
        ..Default::default()
    }
    .read_file()
    .await
    .stringify_err()?;

    let profiles_dir = dirs::app_profiles_dir().stringify_err()?;
    let file_path = profiles_dir.join(rel_path.as_str());
    let file_path_str = file_path.to_string_lossy().to_string();

    // 保存新的配置文件
    fs::write(&file_path, &file_data).await.stringify_err()?;

    logging!(
        info,
        Type::Config,
        "[cmd配置save] 开始验证配置文件: {}, 是否为merge文件: {}",
        file_path_str,
        is_merge_file
    );

    let changes_applied = handle_saved_profile_file(
        &file_path_str,
        &file_path,
        &original_content,
        is_merge_file,
        is_script_file,
        affects_runtime,
    )
    .await?;

    if changes_applied.is_valid()
        && let Some(trigger) = backup_trigger
    {
        AutoBackupManager::trigger_backup(trigger);
    }

    Ok(changes_applied)
}

/// Save several enhancement files as one transaction.
///
/// Split-routing edits touch providers, groups and rules at the same time. A
/// sequence of individual saves would validate each intermediate state and can
/// reject a perfectly valid final configuration (for example, a rule briefly
/// pointing at a group that is written in the next file). This command writes,
/// validates and activates the complete set atomically, restoring every file
/// when either file-level or final runtime validation fails.
#[tauri::command]
pub async fn save_profile_files(files: Vec<ProfileFilePatch>) -> CmdResult<ValidationOutcome> {
    if files.is_empty() {
        return Ok(ValidationOutcome::Valid);
    }

    let (patches, affects_runtime) = prepare_profile_patches(files).await?;
    if let Err(error) = write_profile_patches(&patches).await {
        restore_profile_patches(&patches).await;
        return Err(error);
    }

    let validation = validate_profile_patches(&patches).await?;
    if !validation.is_valid() {
        return Ok(validation);
    }

    let outcome = if affects_runtime {
        apply_profile_patches(&patches).await?
    } else {
        ValidationOutcome::Valid
    };
    if !outcome.is_valid() {
        return Ok(outcome);
    }

    backup_profile_patches(&patches);
    Ok(ValidationOutcome::Valid)
}

async fn prepare_profile_patches(files: Vec<ProfileFilePatch>) -> CmdResult<(Vec<PreparedProfilePatch>, bool)> {
    let mut seen = HashSet::new();
    let mut patches = Vec::with_capacity(files.len());
    let mut affects_runtime = false;

    {
        let profiles = Config::profiles().await;
        let profiles_guard = profiles.latest_arc();
        for patch in files {
            if !seen.insert(patch.index.clone()) {
                return Err(format!("duplicate profile file index: {}", patch.index).into());
            }

            let item = profiles_guard.get_item(&patch.index).stringify_err()?;
            let rel_path = item.file.clone().ok_or("file field is null")?;
            let is_merge = item.itype.as_ref().is_some_and(|t| t == "merge");
            let is_script = item.itype.as_ref().is_some_and(|t| t == "script") || rel_path.ends_with(".js");
            let original_content = PrfItem {
                file: Some(rel_path.clone()),
                ..Default::default()
            }
            .read_file()
            .await
            .stringify_err()?;
            let path = dirs::app_profiles_dir().stringify_err()?.join(rel_path.as_str());
            let runtime = profile_affects_runtime(&profiles_guard, &patch.index);
            affects_runtime |= runtime;
            patches.push(PreparedProfilePatch {
                patch,
                path,
                original_content,
                is_merge,
                is_script,
            });
        }
    }

    Ok((patches, affects_runtime))
}

async fn write_profile_patches(patches: &[PreparedProfilePatch]) -> CmdResult<()> {
    for prepared in patches {
        fs::write(&prepared.path, &prepared.patch.file_data)
            .await
            .stringify_err()?;
    }
    Ok(())
}

async fn restore_profile_patches(patches: &[PreparedProfilePatch]) {
    for prepared in patches {
        let _ = restore_original(&prepared.path, &prepared.original_content).await;
    }
}

async fn validate_profile_patches(patches: &[PreparedProfilePatch]) -> CmdResult<ValidationOutcome> {
    for prepared in patches {
        let (target, file_type) = validation_target(prepared);
        match CoreConfigValidator::validate_config_file_outcome(
            &prepared.path.to_string_lossy(),
            Some(prepared.is_merge),
        )
        .await
        {
            Ok(outcome) if outcome.is_valid() => {}
            Ok(outcome) => {
                restore_profile_patches(patches).await;
                handle_validation_notice(&outcome, target, file_type);
                return Ok(outcome);
            }
            Err(error) => {
                restore_profile_patches(patches).await;
                return Err(error.to_string().into());
            }
        }
    }
    Ok(ValidationOutcome::Valid)
}

const fn validation_target(prepared: &PreparedProfilePatch) -> (ValidationNoticeTarget, &'static str) {
    if prepared.is_script {
        (ValidationNoticeTarget::Script, "脚本文件")
    } else if prepared.is_merge {
        (ValidationNoticeTarget::Merge, "合并配置文件")
    } else {
        (ValidationNoticeTarget::Runtime, "YAML配置文件")
    }
}

async fn apply_profile_patches(patches: &[PreparedProfilePatch]) -> CmdResult<ValidationOutcome> {
    match CoreManager::global().update_config_forced().await {
        Ok(outcome) if outcome.is_valid() => {
            handle::Handle::refresh_clash();
            Ok(ValidationOutcome::Valid)
        }
        Ok(outcome) => {
            restore_profile_patches(patches).await;
            let _ = CoreManager::global().update_config_forced().await;
            handle_validation_notice(&outcome, ValidationNoticeTarget::Runtime, "运行时配置");
            Ok(outcome)
        }
        Err(error) => {
            restore_profile_patches(patches).await;
            let _ = CoreManager::global().update_config_forced().await;
            Err(error.to_string().into())
        }
    }
}

fn backup_profile_patches(patches: &[PreparedProfilePatch]) {
    for prepared in patches {
        if prepared.is_merge && prepared.patch.index == "Merge" {
            AutoBackupManager::trigger_backup(AutoBackupTrigger::GlobalMerge);
        } else if prepared.is_script && prepared.patch.index == "Script" {
            AutoBackupManager::trigger_backup(AutoBackupTrigger::GlobalScript);
        }
        logging!(debug, Type::Config, "批量保存增强文件: {}", prepared.patch.index);
    }
}

async fn restore_original(file_path: &std::path::Path, original_content: &str) -> Result<(), String> {
    fs::write(file_path, original_content).await.stringify_err()
}

fn profile_affects_runtime(profiles: &IProfiles, index: &str) -> bool {
    let Some(current_uid) = profiles.get_current() else {
        return false;
    };
    if current_uid == index {
        return true;
    }

    let Ok(item) = profiles.get_item(current_uid) else {
        return false;
    };
    [
        item.current_merge().map_or("Merge", String::as_str),
        item.current_script().map_or("Script", String::as_str),
        item.current_rules().map_or("Rules", String::as_str),
        item.current_proxies().map_or("Proxies", String::as_str),
        item.current_groups().map_or("Groups", String::as_str),
    ]
    .contains(&index)
}

async fn handle_saved_profile_file(
    file_path_str: &str,
    file_path: &std::path::Path,
    original_content: &str,
    is_merge_file: bool,
    is_script_file: bool,
    affects_runtime: bool,
) -> CmdResult<ValidationOutcome> {
    let (target, file_type) = if is_script_file {
        (ValidationNoticeTarget::Script, "脚本文件")
    } else if is_merge_file {
        (ValidationNoticeTarget::Merge, "合并配置文件")
    } else {
        (ValidationNoticeTarget::Runtime, "YAML配置文件")
    };

    logging!(
        info,
        Type::Config,
        "[cmd配置save] 开始{}验证: {}",
        file_type,
        file_path_str
    );

    match CoreConfigValidator::validate_config_file_outcome(file_path_str, Some(is_merge_file)).await {
        Ok(outcome) if outcome.is_valid() => {
            logging!(info, Type::Config, "[cmd配置save] 文件验证通过: {}", file_path_str);
        }
        Ok(outcome) => {
            logging!(warn, Type::Config, "[cmd配置save] 文件验证失败: {}", outcome);
            restore_original(file_path, original_content).await?;
            handle_validation_notice(&outcome, target, file_type);
            return Ok(outcome);
        }
        Err(e) => {
            logging!(error, Type::Config, "[cmd配置save] 验证过程发生错误: {}", e);
            restore_original(file_path, original_content).await?;
            return Err(e.to_string().into());
        }
    }

    if !affects_runtime {
        return Ok(ValidationOutcome::Valid);
    }

    logging!(
        info,
        Type::Config,
        "[cmd配置save] 保存项影响当前运行时配置，开始统一应用"
    );
    match CoreManager::global().update_config_forced().await {
        Ok(outcome) if outcome.is_valid() => {
            handle::Handle::refresh_clash();
            Ok(ValidationOutcome::Valid)
        }
        Ok(outcome) => {
            logging!(warn, Type::Config, "[cmd配置save] 运行时配置应用失败: {}", outcome);
            restore_original(file_path, original_content).await?;
            handle_validation_notice(&outcome, ValidationNoticeTarget::Runtime, "运行时配置");
            Ok(outcome)
        }
        Err(err) => {
            logging!(error, Type::Config, "[cmd配置save] 运行时配置应用错误: {}", err);
            restore_original(file_path, original_content).await?;
            Err(err.to_string().into())
        }
    }
}
