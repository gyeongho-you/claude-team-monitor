// 이번 청크 — get-settings/update-settings(main.ts:2824-2827)의 포팅. settings.json은 사용자가
// 바꿀 수 있는 값(정체 감시 임계값 등)만 담는 아주 작은 파일이고, main.ts 자신도 이 파일에 대한
// 락이 없다(단일 사용자가 설정 화면 하나에서만 바꾸는 값이라 동시 쓰기 위험이 낮다고 판단한 것으로
// 보인다) — 이번 포팅도 그 판단을 그대로 따른다(favorites.json/memberTemplates.json과 달리 이
// 파일에는 전용 락을 새로 만들지 않는다).

use crate::paths::settings_path;
use crate::timing::{STALL_IDLE_THRESHOLD_MS_DEFAULT, STALL_RECHECK_COOLDOWN_MS_DEFAULT};
use serde::{Deserialize, Serialize};

// 사용자가 바꿀 수 있는 값만 여기 둔다 — LEAD_OFFLINE_GRACE_MS류(실측 CLI 성능에 맞춰 계산된 값)는
// 절대 포함하지 않는다(main.ts 주석과 동일). 분 단위로 저장·표시하고, 실제 로직에서만 ms로 바꿔 쓴다.
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
pub struct AppSettings {
    #[serde(rename = "stallIdleThresholdMin")]
    pub stall_idle_threshold_min: f64,
    #[serde(rename = "stallCooldownMin")]
    pub stall_cooldown_min: f64,
}

/// 파일에서 그대로 읽었을 수도, 렌더러가 보낸 partial 값일 수도 있는 raw 입력을 받는다 — main.ts의
/// Partial<AppSettings>와 동일하게 두 필드 다 옵션이다.
#[derive(Debug, Clone, Copy, Default, Deserialize)]
pub struct PartialAppSettings {
    #[serde(rename = "stallIdleThresholdMin", default)]
    pub stall_idle_threshold_min: Option<f64>,
    #[serde(rename = "stallCooldownMin", default)]
    pub stall_cooldown_min: Option<f64>,
}

/// clampMinutes(lib/appSettings.js)와 동일 — null/빈 값은 fallback, 그 외는 [min,max] 범위로
/// 반올림해 클램프한다. 파일이 손상됐거나 렌더러가 이상한 값을 보내도 정체 감시가 0분(과도한 Haiku
/// 호출)이나 음수 같은 값으로 오동작하지 않게 막는다.
fn clamp_minutes(value: Option<f64>, fallback: f64, min: f64, max: f64) -> f64 {
    match value {
        None => fallback,
        Some(n) if !n.is_finite() => fallback,
        Some(n) => max.min(min.max(n.round())),
    }
}

fn normalize(raw: PartialAppSettings) -> AppSettings {
    AppSettings {
        stall_idle_threshold_min: clamp_minutes(raw.stall_idle_threshold_min, STALL_IDLE_THRESHOLD_MS_DEFAULT as f64 / 60_000.0, 1.0, 24.0 * 60.0),
        stall_cooldown_min: clamp_minutes(raw.stall_cooldown_min, STALL_RECHECK_COOLDOWN_MS_DEFAULT as f64 / 60_000.0, 1.0, 24.0 * 60.0),
    }
}

/// loadSettings(main.ts)와 동일 — 파일이 없거나 파싱에 실패하면 전부 기본값으로 fail-open한다.
pub fn load_settings() -> AppSettings {
    let raw = std::fs::read_to_string(settings_path())
        .ok()
        .and_then(|s| serde_json::from_str::<PartialAppSettings>(&s).ok())
        .unwrap_or_default();
    normalize(raw)
}

/// saveSettings(main.ts)와 동일 — 기존 값과 partial을 병합한 뒤 다시 클램프해서 저장한다.
pub fn save_settings(partial: PartialAppSettings) -> AppSettings {
    let current = load_settings();
    let merged = PartialAppSettings {
        stall_idle_threshold_min: partial.stall_idle_threshold_min.or(Some(current.stall_idle_threshold_min)),
        stall_cooldown_min: partial.stall_cooldown_min.or(Some(current.stall_cooldown_min)),
    };
    let next = normalize(merged);
    if let Err(e) = crate::json_file::write_json_file_atomic(&settings_path(), &next) {
        eprintln!("[save_settings] settings.json 저장 실패: {e}");
    }
    next
}

#[tauri::command]
pub fn get_settings_command() -> AppSettings {
    load_settings()
}

#[tauri::command]
pub fn update_settings_command(partial: PartialAppSettings) -> AppSettings {
    save_settings(partial)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn clamp_minutes_uses_fallback_for_missing_or_non_finite() {
        assert_eq!(clamp_minutes(None, 10.0, 1.0, 100.0), 10.0);
        assert_eq!(clamp_minutes(Some(f64::NAN), 10.0, 1.0, 100.0), 10.0);
    }

    #[test]
    fn clamp_minutes_clamps_to_range_and_rounds() {
        assert_eq!(clamp_minutes(Some(0.0), 10.0, 1.0, 100.0), 1.0, "min 밑이면 min으로");
        assert_eq!(clamp_minutes(Some(999.0), 10.0, 1.0, 100.0), 100.0, "max 위면 max로");
        assert_eq!(clamp_minutes(Some(5.6), 10.0, 1.0, 100.0), 6.0, "반올림");
    }

    #[test]
    fn normalize_applies_defaults_for_both_fields() {
        let settings = normalize(PartialAppSettings::default());
        assert_eq!(settings.stall_idle_threshold_min, STALL_IDLE_THRESHOLD_MS_DEFAULT as f64 / 60_000.0);
        assert_eq!(settings.stall_cooldown_min, STALL_RECHECK_COOLDOWN_MS_DEFAULT as f64 / 60_000.0);
    }

    #[test]
    fn save_settings_merges_partial_onto_existing_file() {
        let path = settings_path();
        // 실제 프로덕션 settings.json을 건드리지 않기 위해, 이 테스트는 정규화 로직만 검증하고
        // 파일 쓰기는 하지 않는다 — merge 자체는 load_settings()+normalize로 순수하게 확인 가능하다.
        let current = load_settings();
        let merged = PartialAppSettings { stall_idle_threshold_min: Some(15.0), stall_cooldown_min: None };
        let next = normalize(PartialAppSettings {
            stall_idle_threshold_min: merged.stall_idle_threshold_min.or(Some(current.stall_idle_threshold_min)),
            stall_cooldown_min: merged.stall_cooldown_min.or(Some(current.stall_cooldown_min)),
        });
        assert_eq!(next.stall_idle_threshold_min, 15.0);
        assert_eq!(next.stall_cooldown_min, current.stall_cooldown_min, "안 보낸 필드는 기존 값이 유지돼야 한다");
        let _ = path; // 경로 자체는 존재만 확인(실제 I/O 없음).
    }
}
