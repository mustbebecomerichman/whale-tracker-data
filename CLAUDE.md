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

## 새 PC에서 즉시 복원 (PC 교체 시)

### 1. 저장소 클론
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

### 2. Cloudflare/KIS 환경변수는 이미 클라우드 측에 저장됨
- Cloudflare Pages env vars는 **서버 측에 영구 저장** — PC와 무관. 새 PC에서 바로 사용 가능
- 로컬 작업은 코드 수정만 하면 됨 (앱 키/시크릿 로컬에 보관 불필요)

### 3. Claude Code 사용 시
- 이 `CLAUDE.md`가 모든 핵심 context 포함 — 첫 메시지에서 자동 로드
- 추가 컨텍스트(사용자 선호, 진행 중 결정 등)는 git 외부에 있는 메모리 파일에 보관:
  `~/.claude/projects/C--Users-USER-whale-tracker-pro/memory/` — PC별로 다시 학습됨 (사용자가 명시적으로 알려주거나 Claude가 관찰하면 자동 축적)
- **즉시 복원에 필요한 모든 사실은 이 `CLAUDE.md`에 명시되어 있어야 함** — 메모리 파일은 보조용

### 4. 배포 워크플로우 확인
```bash
git remote -v          # origin = mustbebecomerichman/whale-tracker-data
gh auth status         # GitHub CLI 인증 필요 (PR 생성/머지용)
```
PR 생성/머지는 `gh pr create` + `gh pr merge --merge --delete-branch=false` 패턴 사용. Cloudflare Pages가 main push를 감지해 자동 배포.

---

## 보안 규칙 (Claude가 반드시 지켜야 할 사항)

1. **API 함수** (`functions/api/*.js`): 반드시 `requireFirebaseUser` AND `rejectUntrustedOrigin` 포함
2. **브라우저 → API 호출**: 반드시 `apiFetch()` 사용 (Firebase ID 토큰 자동 첨부)
3. **CORS**: `Access-Control-Allow-Origin: *` 절대 금지
4. **사용자 입력값**: HTML 삽입 전 반드시 이스케이프 처리
5. **시크릿**: `secrets_local.py`, `serviceAccountKey.json`, `.env*`, `my_portfolio.json` — 절대 커밋 금지

---

## 전략 방향 (2026-05-14 결정)

**비공개/승인제 서비스로 전환**. 공개 출시/광고 수익 모델 폐기. Owner 본인 + 소수 승인된 사용자만 접근.
- AdSense/AdMob 코드는 비활성 상태로 잔존 — 향후 별도 PR로 완전 제거 예정
- Play Store 출시 문서 (`docs/android-store-and-ads.md`) — 보류 처리 필요
- 모든 민감 기능 (KIS 자동 연동 등)은 `requireAdmin` 가드로 본인 전용

---

## KIS 한국투자증권 자동 연동 (2026-05-14 배포 완료)

**관리자 본인의 한투 2계좌를 백엔드에서 직접 조회** — 잔고/거래내역 자동 import.

### 계좌 구성 (코드 hardcoded — `functions/api/kis-*.js`의 `getKisAccounts()`)
| 계좌 | 번호 | 별도 KIS 앱 키 사용 |
|------|------|-------------------|
| ISA | `64635355-01` | 기본 `KIS_APP_KEY` / `KIS_APP_SECRET` |
| 위탁 | `74118276-01` | `KIS_APP_KEY_2` / `KIS_APP_SECRET_2` |

`env.KIS_ACCOUNTS` JSON으로 override 가능.

### 엔드포인트
- `/api/kis-balance` — 국내(`TTTC8434R`) + 해외(`TTTS3012R`, NASD/NYSE/AMEX 순회) 잔고 통합
- `/api/kis-transactions` — 일별 주문체결조회(`TTTC8001R`), 90일 청크 자동 분할, `?year=YYYY` 지원
- `/api/kis-price` — 시세 (앱 키만으로 동작, 계좌 불필요)

### 가드
- 두 API 모두 `requireFirebaseUser` + `rejectUntrustedOrigin` + `requireAdmin(auth.user, env)`
- `ADMIN_EMAIL` env var로 허용 이메일 지정 (기본 `smmoon2030@gmail.com`)

### 토큰 캐싱
`_tokenMem` Map + KV (`kis-access-token-v2:<appKey 끝8자>`)로 앱별 분리

### 프론트 dedup 정책
KIS 연동 시 동일 종목 코드의 기존 `_acctRows` 행은 brokerage 무관하게 모두 삭제 후 KIS 데이터로 교체. 비-KIS 증권사 종목 (미래에셋 등)은 KIS가 안 가져오므로 자동 보존.

### KIS 연동 결과 배너
계좌별 현황 섹션 **하단** (acct-split-grid 아래)에 표시. KIS 앱 기준 자산 대조표 (계좌별 평가금액 + 예수금 + 합계) 포함.

---

## Cloudflare Pages 환경변수 (운영 필수)

`dash.cloudflare.com` → Workers & Pages → `whale-tracker-data` → Settings → Environment variables → Production:

| 변수명 | 필수 | 용도 |
|--------|------|------|
| `KIS_APP_KEY` | ✓ | ISA 계좌용 KIS App Key |
| `KIS_APP_SECRET` | ✓ | ISA 계좌용 KIS App Secret |
| `KIS_APP_KEY_2` | ✓ | 위탁 계좌용 KIS App Key (별도 앱) |
| `KIS_APP_SECRET_2` | ✓ | 위탁 계좌용 KIS App Secret |
| `ADMIN_EMAIL` | (선택) | 본 엔드포인트 허용 이메일. 기본 `smmoon2030@gmail.com` |
| `KIS_MOCK` | (선택) | `"true"`면 모의투자 서버 사용 |
| `KIS_ACCOUNTS` | (선택) | JSON으로 계좌 목록 override |

**환경변수 추가 후 재배포 필요** (자동 안 됨): Deployments 탭 → 최신 → ⋯ → **Retry deployment**.

⚠️ **API 키를 채팅/코드/커밋/문서 어디에도 평문 저장 금지.** 환경변수 이름만 참조.

---

## 데이터 표시 규칙

- **KRW 금액**: 항상 `Math.round()` 적용 (`.999/.001` 트레일링 금지). `formatMoneyByCode`가 처리.
- **합계 footer**: 단일 변환 통합값만 표시 (예: `₩127,326,532`). breakdown은 `title` 속성 hover 툴팁.
- **Sheet 테이블** (`#acct-table`, `#sheet-table`, `#div-table`): 모바일 ≤720px에서도 `display:table` 유지. **카드 그리드 변환 금지** (한 줄 표시).
- **USD 환산**: `≈ $X` 형태로 KRW 아래 별도 줄 (`split-money` 클래스).
- **페이지 max-width**: `main { max-width: 1400px }` — 와이드 모니터에서 스크롤 없이 표시.

---

## 진행 중 / 대기 작업

- [ ] **비공개/승인제 전환** (단계별 PR): Firestore `users/{uid}.approved` + 관리자 패널 토글 + 차단 화면 + `firestore.rules` 강화
- [ ] **광고 코드 완전 제거**: AdSense/AdMob, `ads.txt`, `app-ads.txt` (비공개 전환에 맞춰)
- [ ] **카카오톡 알림 백엔드**: Wilder 매매 후보 시트와 연동, Kakao OpenAPI "나에게 보내기" (사용자가 [developers.kakao.com](https://developers.kakao.com)에서 앱 등록 후 가능)
- [ ] **Play Store 문서 보류 표시** (`docs/android-store-and-ads.md`)

### 결정된 보류 사항
- **미래에셋 등 비-KIS 증권사 자동 연동**: 안 함. 수동 입력 유지 (2026-05-14 사용자 결정).
- **배당수익 자동 연동**: KIS Open API에 배당금 수령 조회 없음. 수동 입력 유지.

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
