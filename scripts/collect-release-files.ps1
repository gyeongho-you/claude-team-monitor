# 릴리스에 올릴 파일을 모은다: 설치 파일(NSIS), exe+resources 압축본, SHA256SUMS.txt.
# 릴리스 워크플로(.github/workflows/release.yml)와 매 푸시의 CI(installer 잡)가 같은 스크립트를 쓴다 — 그래서 태그를 올리기 전에도
# 이 단계(압축본 구성, 체크섬, 필수 파일 확인)가 계속 시험된다.
#
# 사용: pwsh scripts/collect-release-files.ps1 -Version v0.2.0 [-Out dist-release]
# 먼저 `npm run tauri:build:release`로 설치 파일과 exe를 만들어 둬야 한다.
param(
  [Parameter(Mandatory = $true)][string]$Version,
  [string]$Out = "dist-release"
)
$ErrorActionPreference = "Stop"
Set-Location (Split-Path -Parent $PSScriptRoot)

$setup = Get-ChildItem "src-tauri/target/release/bundle/nsis" -Filter "*-setup.exe" -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $setup) { throw "설치 파일(*-setup.exe)을 찾지 못했습니다. 먼저 npm run tauri:build:release를 실행하세요." }
$exe = "src-tauri/target/release/Claude Team Monitor.exe"
if (-not (Test-Path $exe)) { throw "앱 exe를 찾지 못했습니다: $exe" }
$skill = "resources/skills/team-lead/SKILL.md"
if (-not (Test-Path $skill)) { throw "팀장 스킬 파일을 찾지 못했습니다: $skill" }

if (Test-Path $Out) { Remove-Item -Recurse -Force $Out }
New-Item -ItemType Directory -Force $Out | Out-Null
Copy-Item $setup.FullName $Out

# 압축본: exe + resources/ (exe만 따로 옮기면 팀장 스킬을 설치하지 못한다. 팀원 생성은 exe 자신이 맡아서 exe만 있으면 된다)
$name = "Claude-Team-Monitor-$Version-win"
$stage = Join-Path ([IO.Path]::GetTempPath()) ("ctm-stage-" + [Guid]::NewGuid().ToString("N")) | Join-Path -ChildPath $name
New-Item -ItemType Directory -Force "$stage/resources/skills/team-lead" | Out-Null
Copy-Item $exe $stage
Copy-Item $skill "$stage/resources/skills/team-lead/"
$zip = Join-Path $Out "$name.zip"
Compress-Archive -Path "$stage/*" -DestinationPath $zip
Remove-Item -Recurse -Force (Split-Path -Parent $stage)

# 압축본에 꼭 있어야 하는 것이 들어갔는지 확인
Add-Type -AssemblyName System.IO.Compression.FileSystem
$entries = [IO.Compression.ZipFile]::OpenRead((Resolve-Path $zip)).Entries | ForEach-Object { $_.FullName.Replace('\', '/') }
foreach ($need in @("Claude Team Monitor.exe", "resources/skills/team-lead/SKILL.md")) {
  if ($entries -notcontains $need) { throw "압축본에 $need 가 없습니다: $($entries -join ', ')" }
}

# 체크섬
$lines = Get-ChildItem $Out -File | Where-Object { $_.Name -ne "SHA256SUMS.txt" } | ForEach-Object {
  "{0}  {1}" -f (Get-FileHash $_.FullName -Algorithm SHA256).Hash.ToLower(), $_.Name
}
$lines | Set-Content -Encoding utf8 (Join-Path $Out "SHA256SUMS.txt")
if (@($lines).Count -ne 2) { throw "체크섬 대상은 설치 파일과 압축본 2개여야 합니다(현재 $(@($lines).Count)개)" }
Get-Content (Join-Path $Out "SHA256SUMS.txt")
Write-Host "배포 파일을 $Out 에 모았습니다."
