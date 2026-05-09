# WhaleTracker Pro — Claude Context

## 프로젝트 개요

기관 투자자(고래) 공시 데이터를 추적하고, 사용자 개인 포트폴리오를 관리하는 웹/PWA 앱.
- **앱 이름**: WhaleTracker Pro
- **도메인**: https://whale-tracker-data.pages.dev
- **GitHub**: https://github.com/mustbebecomerichman/whale-tracker-data
- **호스팅**: Cloudflare Pages (정적 파일) + Firebase (Auth/Firestore/Functions)
- **연락처**: smmoon2030@gmail.com

---

## 아키텍처

```
whale tracker pro/
├── index.html              # 메인 SPA (단일 파일 앱, 259KB — 전체 프론트엔드)
├── about.html              # 서비스 소개 페이지
├── privacy.html            # 개인정보처리방침
├── manifest.webmanifest    # PWA 매니페스트
├── sw.js                   # 서비스 워커
├── ads.txt / app-ads.txt   # AdSense/AdMob 퍼블리셔 인증 파일
├── _headers                # Cloudflare Pages 보안 헤더 (CSP 등)
├── firebase.json           # Firebase 프로젝트 설정
├── firestore.rules         # Firestore 보안 규칙
├── dart_fetcher.py         # DART/SEC 데이터 수집 Python 스크립트
├── functions/              # Firebase Cloud Functions (Node.js)
│   ├── api/                # API 엔드포인트 (모두 requireFirebaseUser + rejectUntrustedOrigin 필수)
│   └── _shared/            # 공통 미들웨어
├── icons/                  # PWA 아이콘 (192px, 512px)
├── docs/                   # 작업 계획 문서
│   ├── android-store-and-ads.md      # Play Store 출시 로드맵
│   ├── frontend-security-checklist.md
│   └── assetlinks.template.json      # Digital Asset Links 템플릿
└── .github/
    ├── workflows/
    │   ├── daily_update.yml           # 매일 10시 KST DART/SEC 데이터 수집
    │   ├── deploy_firestore_rules.yml # firestore.rules 변경 시 자동 배포
    │   └── security_guard.yml        # API 보안 패턴 강제 검사
    └── scripts/
        └── deploy-firestore-rules.js
```

---

## 기술 스택

| 레이어 | 기술 |
|--------|------|
| 프론트엔드 | Vanilla JS + HTML (단일 index.html SPA) |
| 인증 | Firebase Auth (Google 로그인) |
| DB | Firebase Firestore |
| API | Firebase Cloud Functions (Node.js 22) |
| 데이터 수집 | Python 3.11 (dart_fetcher.py) |
| 호스팅 | Cloudflare Pages |
| CI/CD | GitHub Actions |
| 모바일 | PWA (Android TWA 예정) |

---

## GitHub Secrets (Actions에서 필요)

| 시크릿 이름 | 설명 |
|-------------|------|
| `DART_API_KEY` | 금융감독원 DART Open API 키 |
| `FIREBASE_SERVICE_ACCOUNT` | Firebase 서비스 계정 JSON (project_id: `whaletracker-pro`) |

로컬 개발용 시크릿은 `.env.local` 또는 `secrets_local.py`에 보관 (`.gitignore`에 포함).

---

## 로컬 개발 환경 세팅

새 PC에서 시작할 때:

```powershell
# Windows
git clone https://github.com/mustbebecomerichman/whale-tracker-data.git "whale tracker pro"
cd "whale tracker pro"
.\setup.ps1
```

```bash
# Linux / Mac
git clone https://github.com/mustbebecomerichman/whale-tracker-data.git "whale tracker pro"
cd "whale tracker pro"
bash setup.sh
```

---

## 보안 규칙 (Claude가 반드시 지켜야 할 사항)

1. **API 함수** (`functions/api/*.js`): 반드시 `requireFirebaseUser` AND `rejectUntrustedOrigin` 포함
2. **브라우저 → API 호출**: 반드시 `apiFetch()` 사용 (Firebase ID 토큰 자동 첨부)
3. **CORS**: `Access-Control-Allow-Origin: *` 절대 금지
4. **사용자 입력값**: HTML 삽입 전 반드시 이스케이프 처리
5. **시크릿**: `secrets_local.py`, `serviceAccountKey.json`, `.env*`, `my_portfolio.json` — 절대 커밋 금지

---

## 현재 작업 상태 (2026-05-09 기준)

### 완료된 작업
- [x] 모바일 UI (컴팩트 헤더, 바텀 네비, 아이콘 기반 포트폴리오)
- [x] PWA 기반 (manifest, sw.js, icons)
- [x] Cloudflare Pages 보안 헤더 (`_headers`)
- [x] AdSense/AdMob 스캐폴딩 (비활성화 상태, 실제 ID 발급 후 활성화)
- [x] Play Store 출시 계획 문서 완성
- [x] 포트폴리오 자산 분류 개선

### 진행 중 / 대기 중
- [ ] Google Play Store 등록 (패키지명, 서명 SHA-256 확보 필요)
- [ ] `assetlinks.json` 실제 값으로 배포 (플레이스홀더 → 실제 값)
- [ ] AdSense 승인 → 실제 `ca-pub-...` ID로 교체
- [ ] AdMob 앱 등록 → `app-ads.txt` 실제 값으로 교체
- [ ] Firebase Cloud Functions 추가 개발

### Owner 입력 필요
- Google Play 패키지명 (예: `com.whaletracker.pro`)
- Android 서명 SHA-256 지문
- Play Store 그래픽 (앱 아이콘, 피처 그래픽, 스크린샷)
- AdSense 퍼블리셔 ID / 광고 슬롯 ID
- AdMob 앱 ID / 광고 유닛 ID

---

## GitHub Actions 자동화

| 워크플로우 | 트리거 | 역할 |
|-----------|--------|------|
| `daily_update.yml` | 매일 UTC 01:00 (KST 10:00) + push | DART 국민연금·대량보유, SEC 13F 글로벌 고래 수집 |
| `deploy_firestore_rules.yml` | `firestore.rules` 변경 push | Firestore 보안 규칙 자동 배포 |
| `security_guard.yml` | `index.html`, `functions/**` 변경 | API 보안 패턴 검사 |

---

## 배포 절차

```bash
# 1. 정적 파일은 main 브랜치에 push하면 Cloudflare Pages가 자동 배포
git push origin main

# 2. Firestore 규칙은 firestore.rules 수정 후 push하면 GitHub Actions가 배포
# 3. Firebase Functions는 별도 수동 배포
cd functions && firebase deploy --only functions
```

---

## 코드 수정 전 검증 (업로드 후보 전 실행)

```powershell
node -e "const fs=require('fs'); JSON.parse(fs.readFileSync('manifest.webmanifest','utf8')); console.log('manifest ok')"
node -e "const fs=require('fs'),vm=require('vm'); const html=fs.readFileSync('index.html','utf8'); [...html.matchAll(/<script(?![^>]*src=)[^>]*>([\s\S]*?)<\/script>/gi)].forEach((m,i)=>new vm.Script(m[1],{filename:'index-inline-'+i+'.js'})); console.log('inline scripts ok')"
git diff --check
```
