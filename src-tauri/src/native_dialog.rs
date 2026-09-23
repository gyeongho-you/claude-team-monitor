// 이번 청크 — pick-directory(main.ts:2467)의 포팅. Electron의 dialog.showOpenDialog(mainWindow,
// {properties:['openDirectory']})에 대응하는 Tauri 쪽은 코어가 아니라 공식 플러그인
// (tauri-plugin-dialog)이 제공한다 — lib.rs의 .plugin(tauri_plugin_dialog::init())으로 등록했다.
//
// 취소하거나(main.ts: result.canceled) 결과가 없으면 None을 돌려준다(main.ts와 동일한 계약).
// 플러그인의 pick_folder는 콜백 기반 API라 oneshot 채널로 async 커맨드 시그니처에 맞춘다.

use tauri::AppHandle;
use tauri_plugin_dialog::DialogExt;

#[tauri::command]
pub async fn pick_directory_command(app: AppHandle) -> Option<String> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    app.dialog().file().pick_folder(move |folder| {
        let _ = tx.send(folder);
    });
    match rx.await {
        Ok(Some(path)) => Some(path.to_string()),
        _ => None,
    }
}
