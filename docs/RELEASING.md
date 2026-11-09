# 릴리스 방법

릴리스는 **태그를 올리면** GitHub Actions(`.github/workflows/release.yml`)가 설치 파일을 만들어 릴리스에 붙입니다. 사람이 하는 일은 버전을 올리고 태그를 푸시하는 것뿐입니다.

## 순서

1. 버전을 세 곳에서 같은 숫자로 올립니다: `package.json`, `src-tauri/Cargo.toml`, `src-tauri/tauri.conf.json` (그리고 `npm install`/`cargo build`로 잠금 파일 갱신).
2. `CHANGELOG.md` 맨 위에 이번 버전 항목을 씁니다.
3. 테스트가 모두 통과하는지 확인합니다: `npm run typecheck && npm test`, `cd src-tauri && cargo test --lib`.
4. `main`에 반영한 뒤 태그를 올립니다.
   ```bash
   git tag v0.2.0
   git push origin v0.2.0
   ```
5. Actions의 **Release** 워크플로가 끝나면 릴리스 페이지에 다음이 올라옵니다.
   - `Claude Team Monitor_X.Y.Z_x64-setup.exe` — 설치 파일(권장)
   - `Claude-Team-Monitor-vX.Y.Z-win.zip` — exe + `resources/` 압축본
   - `SHA256SUMS.txt` — 위 파일들의 체크섬
6. 앱의 "새 버전 확인"은 이 저장소의 **최신 릴리스**(`/releases/latest`)를 봅니다. 초안(draft)·사전 릴리스(prerelease)는 보이지 않습니다.

워크플로는 태그 이름(`vX.Y.Z`)과 `package.json`의 버전이 다르면 실패합니다(버전을 올리지 않고 태그만 올리는 실수 방지).

## 코드 서명 (아직 안 되어 있습니다 — 사람이 해야 합니다)

서명이 없으면 Windows SmartScreen이 "알 수 없는 게시자" 경고를 띄웁니다. 서명하려면 **코드 서명 인증서**가 필요하고, 이것은 돈과 신원 확인이 필요해서 자동화할 수 없습니다.

1. 인증서를 구입합니다(OV 또는 EV. EV는 SmartScreen 경고를 바로 없애고, OV는 평판이 쌓일 때까지 경고가 남을 수 있습니다).
2. 인증서를 `.pfx`로 내보내 **base64로 인코딩**하고, 저장소 Settings → Secrets and variables → Actions에 등록합니다.
   - `WINDOWS_CERT_PFX_BASE64` — pfx 파일의 base64
   - `WINDOWS_CERT_PASSWORD` — pfx 비밀번호
3. 두 값이 있으면 `release.yml`이 자동으로 서명 단계를 실행합니다(없으면 그 단계를 건너뛰고 서명 없는 설치 파일을 만듭니다).

> 이 서명 단계는 **작성만 되어 있고 실제 인증서로 시험한 적이 없습니다.** 처음 서명 릴리스를 만들 때 Actions 로그에서 서명 단계가 성공했는지, 설치 파일의 속성 → 디지털 서명 탭이 보이는지 확인하세요.

## 자동 업데이트 (아직 없습니다 — 사람이 정해야 합니다)

지금은 새 버전이 있다는 **알림만** 하고, 설치는 사용자가 직접 합니다. 자동 업데이트(Tauri updater)를 쓰려면:

1. `tauri signer generate`로 업데이트 서명 키 쌍을 만듭니다. **비밀 키는 절대 저장소에 넣지 말고** Actions secret(`TAURI_SIGNING_PRIVATE_KEY`)에만 둡니다. 공개 키는 `tauri.conf.json`의 `plugins.updater.pubkey`에 넣습니다.
2. 업데이트 매니페스트(`latest.json`)를 릴리스에 올리고 그 주소를 `plugins.updater.endpoints`에 적습니다.
3. 앱에 updater 플러그인을 추가하고 "업데이트 설치" UI를 만듭니다.

이 작업은 키 관리 결정이 필요해서 코드만으로 끝낼 수 없습니다.

## 체크섬 확인 (사용자용)

```powershell
Get-FileHash ".\Claude Team Monitor_0.2.0_x64-setup.exe" -Algorithm SHA256
```
출력 값이 릴리스의 `SHA256SUMS.txt`와 같아야 합니다. 서명이 없는 동안에는 이것이 받은 파일이 바뀌지 않았다는 유일한 확인 수단입니다.
