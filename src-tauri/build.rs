fn main() {
  // 빌드 시각(유닉스 초)을 앱에 심는다 — 같은 버전 번호로 여러 번 빌드해도 헤더에서 어느 빌드인지 구분하려는 용도.
  // 소스·화면 파일이 바뀌어 다시 빌드될 때마다 갱신되도록 감시 대상을 지정한다.
  let secs = std::time::SystemTime::now()
    .duration_since(std::time::UNIX_EPOCH)
    .map(|d| d.as_secs())
    .unwrap_or(0);
  println!("cargo:rustc-env=CTM_BUILD_UNIX={secs}");
  println!("cargo:rerun-if-changed=src");
  println!("cargo:rerun-if-changed=../renderer");
  println!("cargo:rerun-if-changed=tauri.conf.json");
  tauri_build::build()
}
