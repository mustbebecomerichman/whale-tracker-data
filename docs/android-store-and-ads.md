# WhaleTracker Pro Android Store And Ads Plan

Last updated: 2026-05-03

## Current readiness snapshot

- PWA manifest, service worker, 192/512 icons, public `about.html`, and public `privacy.html` are present.
- AdSense/AdMob scaffolding is present but intentionally disabled until real publisher and slot IDs are issued.
- Static security headers are now prepared in `_headers` for Cloudflare Pages. The strict CSP candidate is report-only first so Firebase login and future ad tags can be checked before enforcement.
- Frontend user-entered portfolio values in the main transaction/account/dividend/price-detail rendering paths are escaped before being inserted into HTML.
- Play Console policy checks were refreshed on 2026-05-03 against official Google help pages.

## Implemented in this repository

- Mobile UI is now app-oriented: compact header, bottom navigation, icon-based portfolio sections, compact JSON import, and quote placeholders before lookup.
- PWA foundation is included: `manifest.webmanifest`, `sw.js`, `icons/icon-192.png`, `icons/icon-512.png`, and public `privacy.html`.
- Ad monetization scaffolding is included but disabled until real IDs are issued: `ads.txt`, `app-ads.txt`, and the `ADSENSE_CLIENT_ID` / `ADSENSE_SLOTS` config in `index.html`.

## Android Store upload path

1. Create or verify a Google Play Console developer account.
2. Keep the production domain as the developer website: `https://whale-tracker-data.pages.dev`.
3. Build the Android app as a Trusted Web Activity rather than a plain WebView, because Google login must run in a trusted browser context.
4. Generate the Android App Bundle (`.aab`) with Bubblewrap or an Android project using the TWA helper library. As of 2026-05-03, new mobile app submissions and updates should target Android 15 / API level 35 or higher.
5. After the Android package name and signing certificate SHA-256 are known, publish a real `/.well-known/assetlinks.json` file for Digital Asset Links. Use `docs/assetlinks.template.json` as the template, but do not publish placeholder values.
6. In Play Console, complete store listing, privacy policy URL, data safety, app access/login instructions, content rating, target countries, testing track, and production rollout.
7. Start with Internal testing. If this is a personal Play developer account created after 2023-11-13, plan for a Closed testing track with at least 12 opted-in testers for 14 consecutive days before requesting production access.

## Play Console listing draft

- App name: `WhaleTracker Pro`
- Short description: `기관 투자자 공시와 개인 포트폴리오를 모바일에서 추적합니다.`
- Full description draft:
  `WhaleTracker Pro는 금융감독원 DART와 SEC EDGAR 등 공개 공시 데이터를 기반으로 기관 투자자 보유 흐름을 정리하고, 사용자가 직접 입력한 포트폴리오의 평가금액, 손익, 기간별 변화를 확인할 수 있는 투자 기록 관리 앱입니다. 본 서비스의 정보는 투자 권유가 아니며, 투자 판단과 책임은 이용자 본인에게 있습니다.`
- Category: Finance
- Privacy policy URL: `https://whale-tracker-data.pages.dev/privacy.html`
- Developer website: `https://whale-tracker-data.pages.dev`
- Contact email: `smmoon2030@gmail.com`

## Data safety draft

- Data collected: email address, display name, Firebase UID, user-entered portfolio/transaction/dividend/holding data, login and consent timestamps.
- Purpose: account management, app functionality, user portfolio storage, security, consent record keeping, analytics/debugging only if added later.
- Sharing: Firebase/Google Cloud and Cloudflare process data as service providers. AdSense/AdMob data sharing only applies after ads are enabled.
- Security practices: data is transmitted over HTTPS; Firestore access is restricted by signed-in user rules; API endpoints require a Firebase ID token and trusted origin.
- Data deletion: users can request deletion by email at `smmoon2030@gmail.com`.

## Ads path

1. Apply for Google AdSense for the web domain. The site must be live, reachable, policy-compliant, and have enough unique content and useful navigation.
2. After AdSense approval, replace `ADSENSE_CLIENT_ID` and `ADSENSE_SLOTS.portfolioMobile` in `index.html` with the real `ca-pub-...` client and ad slot IDs.
3. Replace the commented template in `ads.txt` with the real AdSense publisher line.
4. For the Play Store app, create an AdMob app and ad unit. After the app appears in Google Play, replace the commented template in `app-ads.txt` with the real AdMob publisher line.
5. Keep the first ad placement light: one responsive banner in the portfolio area. Avoid interstitials until retention is proven.

## Owner inputs still required

- Google Play package name, for example `com.whaletracker.pro`.
- Android signing SHA-256 fingerprint, required for `assetlinks.json`.
- Final store listing graphics: app icon, feature graphic, phone screenshots.
- Play Console account type. Google recommends an organization account for financial products and services; if using a post-2023 personal account, prepare the 12-tester closed testing group.
- AdSense publisher ID and ad slot ID.
- AdMob app ID and ad unit IDs.

## Pre-upload validation checklist

Run these before every upload candidate:

```powershell
node -e "const fs=require('fs'); JSON.parse(fs.readFileSync('manifest.webmanifest','utf8')); console.log('manifest ok')"
node -e "const fs=require('fs'),vm=require('vm'); const html=fs.readFileSync('index.html','utf8'); [...html.matchAll(/<script(?![^>]*src=)[^>]*>([\s\S]*?)<\/script>/gi)].forEach((m,i)=>new vm.Script(m[1],{filename:'index-inline-'+i+'.js'})); console.log('inline scripts ok')"
git diff --check
```

## Official references

- Android App Bundle: https://developer.android.com/guide/app-bundle/
- Trusted Web Activity: https://developer.android.com/develop/ui/views/layout/webapps/trusted-web-activities
- Google Play target API requirements: https://support.google.com/googleplay/android-developer/answer/11926878
- Google Play app testing requirements for new personal accounts: https://support.google.com/googleplay/android-developer/answer/14151465
- Google Play developer account types: https://support.google.com/googleplay/android-developer/answer/13634885
- Prepare and roll out a release: https://support.google.com/googleplay/android-developer/answer/9859348
- Google Play user data and privacy policy: https://support.google.com/googleplay/android-developer/answer/10144311
- Google Play Data safety section: https://support.google.com/googleplay/android-developer/answer/10787469
- AdMob Android SDK: https://developers.google.com/admob/android/sdk
- AdSense site readiness: https://support.google.com/adsense/answer/12176698
- AdMob app-ads.txt: https://support.google.com/admob/answer/9363762
