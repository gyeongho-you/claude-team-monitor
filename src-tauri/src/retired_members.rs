// 팀원 등록 파일을 "삭제" 대신 보관(members-retired/)했다가, 같은 팀원이 다시 살아나면 자동 복원한다.
// src/lib/retiredMembers.js와 같은 규칙이다.
//
// 배경(실측 2026-10-20, g1cl-mgt-leader의 팀원 3명이 "유기"된 사고): 팀원이 유휴 60분이면 데몬이 종료
// 처리(`bg retire … settled, idle 61m`)해서 claude agents 목록에서 사라진다. 앱은 목록에서 MEMBER_MISS_
// GRACE_MS(244초) 넘게 안 보이면 "끝난 팀원"으로 보고 등록 파일을 영구 삭제했는데, 팀장이 그 팀원에게
// SendMessage로 후속 지시를 보내면 같은 id로 다시 깨어난다(데몬이 `bg spawned <id> (fleet)`로 되살림) —
// 그러면 살아있는 팀원인데 등록이 없어 어느 팀장 소속인지 모르는 상태가 된다. 삭제 시각도 정확히 맞아떨어졌다
// (65365e2b: 종료 07:58:23Z + 244초 + 폴링 = 등록 폴더 마지막 변경 08:02:30Z).
// 그래서 지울 때는 보관 폴더로 옮기고, 목록에 같은 id가 다시 나타나면 되살린다. 보관본은 14일 뒤 정리한다.

use crate::agents_json::AgentEntry;
use crate::paths::is_safe_id;
use crate::session_registry::{register_member_in, LeadRecord, MemberRecord};
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

const RETIRED_MAX_AGE: Duration = Duration::from_secs(14 * 24 * 3600);

/// members 폴더와 같은 부모 아래의 보관 폴더(…/claude-team-monitor/members-retired).
pub(crate) fn retired_dir_for(members_dir: &Path) -> PathBuf {
    members_dir.parent().unwrap_or(members_dir).join("members-retired")
}

/// 등록 파일을 보관 폴더로 옮긴다(복사 후 원본 삭제). 옮기지 못하면 원본을 지우지 않고 false를 돌려준다 —
/// 보관 실패가 곧 영구 손실이 되면 안 되기 때문이다.
pub(crate) fn archive_member_file(members_dir: &Path, member_id: &str) -> bool {
    if !is_safe_id(member_id) {
        return false;
    }
    let from = members_dir.join(format!("{member_id}.json"));
    if !from.exists() {
        return true;
    }
    let retired = retired_dir_for(members_dir);
    if std::fs::create_dir_all(&retired).is_err() {
        return false;
    }
    let to = retired.join(format!("{member_id}.json"));
    if std::fs::copy(&from, &to).is_err() {
        return false;
    }
    let _ = std::fs::remove_file(&from);
    purge_old_retired(&retired);
    true
}

fn purge_old_retired(retired: &Path) {
    let Ok(entries) = std::fs::read_dir(retired) else { return };
    let now = SystemTime::now();
    for e in entries.flatten() {
        let old = e
            .metadata()
            .and_then(|m| m.modified())
            .ok()
            .and_then(|t| now.duration_since(t).ok())
            .map_or(false, |age| age > RETIRED_MAX_AGE);
        if old {
            let _ = std::fs::remove_file(e.path());
        }
    }
}

/// 보관된 팀원 중 지금 목록에 같은 id로 다시 살아있는 것을 등록 폴더로 되살리고, 되살린 레코드를 members에 더해 돌려준다.
/// 조건: 이미 등록돼 있지 않고, 팀장 자신이 아니고, 소속 팀장이 아직 등록돼 있고, 보관본과 살아있는 세션의 sessionId가 같을 때
/// (둘 다 있는데 다르면 id만 같은 다른 세션이라 복원하지 않는다).
pub(crate) fn restore_retired_members(members_dir: &Path, agents: &[AgentEntry], leads: &[LeadRecord], mut members: Vec<MemberRecord>) -> Vec<MemberRecord> {
    let retired = retired_dir_for(members_dir);
    if !retired.is_dir() {
        return members;
    }
    let lead_ids: HashSet<&str> = leads.iter().map(|l| l.id.as_str()).collect();
    let known: HashSet<String> = members.iter().map(|m| m.member_id.clone()).collect();
    for agent in agents {
        let Some(id) = agent.id.as_deref() else { continue };
        if !is_safe_id(id) || known.contains(id) || lead_ids.contains(id) {
            continue;
        }
        let path = retired.join(format!("{id}.json"));
        let Ok(raw) = std::fs::read_to_string(&path) else { continue };
        let Ok(rec) = serde_json::from_str::<MemberRecord>(&raw) else { continue };
        if rec.member_id != id || !lead_ids.contains(rec.lead_id.as_str()) {
            continue;
        }
        if let Some(sid) = rec.session_id.as_deref() {
            if !agent.session_id.is_empty() && sid != agent.session_id {
                continue;
            }
        }
        register_member_in(members_dir, &rec);
        let _ = std::fs::remove_file(&path);
        members.push(rec);
    }
    members
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("ctm_retired_{tag}_{}", uuid::Uuid::new_v4())).join("members");
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    fn member(id: &str, lead: &str, sid: Option<&str>) -> MemberRecord {
        MemberRecord { member_id: id.to_string(), lead_id: lead.to_string(), created_at: 1, role: Some("implementer".into()), label: Some("라벨".into()), session_id: sid.map(str::to_string), secret: None }
    }

    fn agent(id: &str, sid: &str) -> AgentEntry {
        AgentEntry { id: Some(id.to_string()), pid: Some(1), cwd: String::new(), kind: "background".into(), started_at: None, session_id: sid.to_string(), name: None, status: Some("idle".into()), state: None, waiting_for: None }
    }

    fn lead(id: &str) -> LeadRecord {
        serde_json::from_value(serde_json::json!({ "id": id, "sessionId": "s", "targetDir": "C:/x", "launchedAt": 1 })).unwrap()
    }

    #[test]
    fn archive_moves_file_instead_of_deleting_and_restore_brings_it_back() {
        let dir = tmp("roundtrip");
        register_member_in(&dir, &member("548fd6ef", "c728206b", Some("548fd6ef-aaaa")));
        assert!(archive_member_file(&dir, "548fd6ef"));
        assert!(!dir.join("548fd6ef.json").exists());
        assert!(retired_dir_for(&dir).join("548fd6ef.json").exists());

        let restored = restore_retired_members(&dir, &[agent("548fd6ef", "548fd6ef-aaaa")], &[lead("c728206b")], Vec::new());
        assert_eq!(restored.len(), 1);
        assert_eq!(restored[0].lead_id, "c728206b");
        assert!(dir.join("548fd6ef.json").exists());
        assert!(!retired_dir_for(&dir).join("548fd6ef.json").exists());
    }

    #[test]
    fn restore_skips_when_lead_is_gone_or_session_differs_or_already_registered() {
        let dir = tmp("skips");
        register_member_in(&dir, &member("aaaa1111", "gone-lead", None));
        register_member_in(&dir, &member("bbbb2222", "c728206b", Some("bbbb2222-old")));
        assert!(archive_member_file(&dir, "aaaa1111") && archive_member_file(&dir, "bbbb2222"));
        let leads = [lead("c728206b")];
        let agents = [agent("aaaa1111", "x"), agent("bbbb2222", "bbbb2222-NEW")];
        assert!(restore_retired_members(&dir, &agents, &leads, Vec::new()).is_empty());

        // 이미 등록돼 있으면 중복 복원하지 않는다
        let existing = vec![member("aaaa1111", "c728206b", None)];
        assert_eq!(restore_retired_members(&dir, &[agent("aaaa1111", "x")], &leads, existing).len(), 1);
    }

    #[test]
    fn restore_never_turns_a_lead_into_a_member() {
        let dir = tmp("lead");
        register_member_in(&dir, &member("c728206b", "c728206b", None));
        assert!(archive_member_file(&dir, "c728206b"));
        assert!(restore_retired_members(&dir, &[agent("c728206b", "s")], &[lead("c728206b")], Vec::new()).is_empty());
    }

    #[test]
    fn archive_rejects_unsafe_ids_and_is_noop_for_missing_file() {
        let dir = tmp("unsafe");
        assert!(!archive_member_file(&dir, "../escape"));
        assert!(archive_member_file(&dir, "nothere1"));
    }
}
