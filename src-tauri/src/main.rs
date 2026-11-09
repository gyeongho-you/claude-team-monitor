// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
  // claude CLI가 팀장 세션에 붙이는 팀원 생성 MCP 서버로 실행된 경우 — 창을 띄우지 않고 stdio 서버로만 동작한다(mcp_server.rs 설명 참고).
  if std::env::args().nth(1).as_deref() == Some(app_lib::mcp_server::MCP_SERVER_FLAG) {
    app_lib::mcp_server::run_stdio();
    return;
  }
  app_lib::run();
}
