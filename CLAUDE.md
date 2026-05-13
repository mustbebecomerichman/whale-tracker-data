# WhaleTracker Pro — Claude 작업 가이드

기관 투자자 지분 추적 + 개인 포트폴리오 관리 PWA. 모바일 최적화 단일 페이지 앱(SPA)이며 Cloudflare Pages + Firebase로 운영된다.

## 배포·런타임 구조

- **호스팅**: Cloudflare Pages (`/functions/api/*` 서버리스 함수 포함)
- **인증·DB**: Firebase Authentication(Google 로그인 우선) + Firestore
- **PWA**: `manifest.webmanifest` + `sw.js`
- **GitHub Pages 미러**: 정적만 동작, `/api` 함수는 Cloudflare Pages 도메인에서만 호출 가능
- **저장소**: `mustbebecomerichman/whale-tracker-data` (origin/main 배포 트리거)

## 핵심 파일

| 파일/디렉토리 | 역할 |
|---|---|
| `index.html` (≈4,800줄) | **SPA 전체** — HTML/CSS/JS 모두 인라인. 모든 페이지·기능이 여기 있음 |
| `dart_fetcher.py` | DART(전자공시) 대량보유·임원 데이터 수집 스크립트 |
| `firestore.rules` | DB 보안 규칙. 관리자: `smmoon2030@gmail.com` 또는 custom claim `admin=true` 또는 `admins/{uid}` 문서 |
| `firebase.json` | Firestore rules 배포 설정만 (호스팅은 Cloudflare) |
| `functions/api/fx-rate.js` | 환율(KRW/USD TTS) 조회 |
| `functions/api/kis-price.js` | 한국·미국 시세 조회 (KIS, Stooq fallback) |
| `functions/api/supply-demand.js` | 종목 수급 데이터 |
| `functions/_shared/firebase-auth.js` | API 함수용 Firebase 토큰 검증 |
| `_headers` | Cloudflare Pages 보안 헤더 (CSP, HSTS 등) |
| `sw.js`, `manifest.webmanifest` | PWA 캐시·설치 |
| `privacy.html`, `about.html` | 개인정보처리방침·소개 |
| `docs/android-store-and-ads.md` | Google Play 스토어 등록·광고 가이드 |
| `docs/frontend-security-checklist.md` | 프런트 보안 체크리스트 |
| `docs/assetlinks.template.json` | Android Digital Asset Links 템플릿 |

## index.html 페이지 구조

`showPage(id)`로 전환되는 SPA 페이지들:

| ID | 라벨 | 설명 |
|---|---|---|
| `page-mypage` | MY자산 | 개인 포트폴리오. 탭: 자산/국내주식/해외주식. 계좌별·종목별 현황, 기간 손익, 배당, 거래내역 |
| `page-nps` | 퀀트 스크리너 | 5종 퀀트 전략(밸런스/가치/모멘텀 등) 점수화. `_quantAll` + `scoreQuantRows()` |
| `page-alert` | 국민연금 | 국민연금 보유 종목 + 해외 13F |
| `page-legend` | 대량보유 / 투자전설 | 5%이상 대량보유 + 글로벌 슈퍼투자자 13F |
| `page-admin` | 관리자 | 데이터 업로드, 사용자 승인 |

## 데이터 흐름

- **whale_data 문서**: Firestore `whale_data/current` (국내), `whale_data/global` (해외 13F·전설 투자자)
- **클라이언트 캐시**: `localStorage['whaleDataCacheV2']`. TTL 30분 + **날짜 비교**로 매일 자정에 만료 (`readWhaleDataCache()`)
- **포트폴리오**: Firestore `portfolios/{uid}` — 계좌별 행(`_acctRows`), 거래내역, 배당
- **시세**: `/api/kis-price` 호출, 결과는 행에 즉시 반영 (Cloudflare Pages 도메인에서만)
- **환율(TTS)**: `/api/fx-rate` 자동 조회, `localStorage['fxTtsRate']`에 캐시

## 코드 스타일·관습

- **CSS·JS 모두 `index.html`에 인라인**. 파일 분리 X. 새 기능 추가 시에도 인라인 유지.
- **Vanilla JS**, 빌드 도구 없음. 함수형으로 글로벌 변수(`_quantAll`, `_acctRows`, `_fxTtsRate` 등) 사용.
- **모바일 퍼스트**: `@media(max-width:760px)` 블록(약 567~900줄)에 모바일 전용 규칙. 데스크톱과 모바일 양쪽 모두 확인 필요.
- **탭 토글**: `setPortfolioAssetTab('all'|'domestic'|'overseas')`가 `#page-mypage`에 `asset-tab-*` 클래스를 토글, CSS로 표시/숨김 처리.
- **금액 표시**: KRW/USD 듀얼은 `splitMoneyHtml(krw,usd)` — `.split-money` 컨테이너에 `.krw`/`.usd` 두 줄. 메인 총 평가금액(`#mp-total`)은 CSS로 수평 정렬.
- **커밋 메시지**: 짧은 영문 동사구 (예: `Add ...`, `Improve ...`, `Fix ...`). 한국어 본문 가능.

## 보안 주의사항

- `.gitignore`에 있는 파일들 **절대 커밋 금지**: `secrets_local.py`, `serviceAccountKey.json`, `.env*`, `my_portfolio.json`, `whale_data.json`, `global_whales.json`
- Firestore 규칙은 `primaryAdmin || adminByClaim || adminByDoc` 패턴. 관리자 권한 변경 시 반드시 3가지 모두 일관 유지.
- `_headers`의 CSP 손대지 말 것. 외부 스크립트 추가 시 CSP도 함께 갱신.
- API Origin 검증: `functions/_shared/firebase-auth.js`에서 토큰 + Origin 화이트리스트 검사.

## 자주 하는 작업

- **신규 페이지 추가**: `<div class="page" id="page-XXX">` HTML + `showPage` 분기 + 헤더 nav 버튼.
- **퀀트 전략 추가**: `QUANT_METHODS` 객체에 weights 추가, `#quant-tabs`에 버튼 추가.
- **시세 API 변경**: `functions/api/kis-price.js`만 수정. 클라이언트는 `fetchAndUpdateAcctPrices()`/`showHoldingDetail()`.
- **Firestore 규칙 배포**: 자동 — `firestore.rules` 푸시 시 GitHub Actions가 배포 (`Auto deploy Firestore rules` 커밋 참고).

## 환경별 주의

- **로컬 개발**: `index.html`을 직접 열면 `/api` 호출 실패. Wrangler(`npx wrangler pages dev .`) 또는 배포 후 확인.
- **GitHub Pages**: 정적 미러 — 시세 조회 안 됨. 안내 메시지 표시됨.
- **Cloudflare Pages**: 풀 기능. 환경변수(KIS API 키 등)는 Cloudflare Dashboard에서 설정.

## 작업 시 체크리스트

1. 모바일/데스크톱 양쪽 CSS 모두 확인 (`@media(max-width:760px)`)
2. 자산 탭 3종(자산/국내/해외) 모두 정상 표시 확인
3. 금액 표시는 KRW/USD 듀얼 케이스 확인
4. Firestore 규칙 수정 시 관리자/일반사용자/비로그인 3케이스 검증
5. 커밋 메시지는 영문 동사구, 한국어 본문 OK
