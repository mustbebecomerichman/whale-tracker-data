#!/usr/bin/env bash
# WhaleTracker Pro — Linux/Mac 개발 환경 세팅 스크립트
# 새 PC에서 git clone 후 이 스크립트를 실행하세요.
# 사용법: bash setup.sh

set -euo pipefail

echo "=== WhaleTracker Pro 개발 환경 세팅 ==="

# 1. Python 패키지 설치
echo ""
echo "[1/4] Python 패키지 설치 중..."
if command -v python3 &>/dev/null; then
    python3 -m pip install -r requirements.txt
    echo "  Python 패키지 설치 완료"
else
    echo "  경고: python3이 없습니다. 설치 후 다시 실행하세요."
fi

# 2. Node.js / Firebase CLI 확인
echo ""
echo "[2/4] Node.js 및 Firebase CLI 확인 중..."
if command -v node &>/dev/null; then
    echo "  Node.js $(node --version) 감지됨"
    if ! command -v firebase &>/dev/null; then
        echo "  Firebase CLI 설치 중..."
        npm install -g firebase-tools
    else
        echo "  Firebase CLI 이미 설치됨: $(firebase --version)"
    fi
else
    echo "  경고: Node.js가 없습니다. https://nodejs.org 에서 설치하세요."
fi

# 3. Functions 의존성 설치
echo ""
echo "[3/4] Firebase Functions 의존성 설치 중..."
if [ -f "functions/package.json" ]; then
    (cd functions && npm install)
    echo "  Functions 의존성 설치 완료"
else
    echo "  functions/package.json 없음, 건너뜀"
fi

# 4. 시크릿 파일 안내
echo ""
echo "[4/4] 시크릿 설정 안내..."
if [ ! -f "secrets_local.py" ]; then
    echo "  secrets_local.py 파일이 없습니다."
    echo "  .env.example 을 참고하여 secrets_local.py 를 만들고 아래 값을 채우세요:"
    echo "    - DART_API_KEY"
    echo "    - FIREBASE_SERVICE_ACCOUNT (또는 serviceAccountKey.json)"
else
    echo "  secrets_local.py 존재 확인"
fi

echo ""
echo "=== 세팅 완료 ==="
echo "다음 단계:"
echo "  - CLAUDE.md 를 읽어 프로젝트 현황을 파악하세요"
echo "  - claude 명령으로 작업을 이어가세요"
echo "  - 배포: git push origin main (Cloudflare Pages 자동 배포)"
