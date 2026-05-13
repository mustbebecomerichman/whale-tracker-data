# WhaleTracker Pro — Windows 개발 환경 세팅 스크립트
# 새 PC에서 git clone 후 이 스크립트를 실행하세요.
# 사용법: .\setup.ps1

$ErrorActionPreference = "Stop"

Write-Host "=== WhaleTracker Pro 개발 환경 세팅 ===" -ForegroundColor Cyan

# 1. Python 패키지 설치
Write-Host "`n[1/4] Python 패키지 설치 중..." -ForegroundColor Yellow
if (Get-Command python -ErrorAction SilentlyContinue) {
    python -m pip install -r requirements.txt
    Write-Host "  Python 패키지 설치 완료" -ForegroundColor Green
} else {
    Write-Host "  경고: Python이 설치되어 있지 않습니다. https://python.org 에서 설치하세요." -ForegroundColor Red
}

# 2. Node.js / Firebase CLI 확인
Write-Host "`n[2/4] Node.js 및 Firebase CLI 확인 중..." -ForegroundColor Yellow
if (Get-Command node -ErrorAction SilentlyContinue) {
    $nodeVersion = node --version
    Write-Host "  Node.js $nodeVersion 감지됨" -ForegroundColor Green
    if (-not (Get-Command firebase -ErrorAction SilentlyContinue)) {
        Write-Host "  Firebase CLI 설치 중..." -ForegroundColor Yellow
        npm install -g firebase-tools
    } else {
        Write-Host "  Firebase CLI 이미 설치됨: $(firebase --version)" -ForegroundColor Green
    }
} else {
    Write-Host "  경고: Node.js가 없습니다. https://nodejs.org 에서 설치하세요." -ForegroundColor Red
}

# 3. Functions 의존성 설치
Write-Host "`n[3/4] Firebase Functions 의존성 설치 중..." -ForegroundColor Yellow
if (Test-Path "functions\package.json") {
    Push-Location functions
    npm install
    Pop-Location
    Write-Host "  Functions 의존성 설치 완료" -ForegroundColor Green
} else {
    Write-Host "  functions/package.json 없음, 건너뜀" -ForegroundColor Gray
}

# 4. 시크릿 파일 안내
Write-Host "`n[4/4] 시크릿 설정 안내..." -ForegroundColor Yellow
if (-not (Test-Path "secrets_local.py")) {
    Write-Host "  secrets_local.py 파일이 없습니다." -ForegroundColor Red
    Write-Host "  .env.example 을 참고하여 secrets_local.py 를 만들고 아래 값을 채우세요:" -ForegroundColor Yellow
    Write-Host "    - DART_API_KEY" -ForegroundColor White
    Write-Host "    - FIREBASE_SERVICE_ACCOUNT (또는 serviceAccountKey.json)" -ForegroundColor White
} else {
    Write-Host "  secrets_local.py 존재 확인" -ForegroundColor Green
}

Write-Host "`n=== 세팅 완료 ===" -ForegroundColor Cyan
Write-Host "다음 단계:" -ForegroundColor White
Write-Host "  - CLAUDE.md 를 읽어 프로젝트 현황을 파악하세요"
Write-Host "  - claude 명령으로 작업을 이어가세요"
Write-Host "  - 배포: git push origin main (Cloudflare Pages 자동 배포)"
