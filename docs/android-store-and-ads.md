# WhaleTracker Pro Android Store And Ads Plan

Last updated: 2026-04-30

## Implemented in this repository

- Mobile UI is now app-oriented: compact header, bottom navigation, icon-based portfolio sections, compact JSON import, and quote placeholders before lookup.
- PWA foundation is included: `manifest.webmanifest`, `sw.js`, `icons/icon-192.png`, `icons/icon-512.png`, and public `privacy.html`.
- Ad monetization scaffolding is included but disabled until real IDs are issued: `ads.txt`, `app-ads.txt`, and the `ADSENSE_CLIENT_ID` / `ADSENSE_SLOTS` config in `index.html`.

## Android Store path

1. Create or verify a Google Play Console developer account.
2. Keep the production domain as the developer website: `https://whale-tracker-data.pages.dev`.
3. Build the Android app as a Trusted Web Activity rather than a plain WebView, because Google login must run in a trusted browser context.
4. Generate the Android App Bundle (`.aab`) with Bubblewrap or an Android project using the TWA helper library.
5. After the Android package name and signing certificate SHA-256 are known, publish a real `/.well-known/assetlinks.json` file for Digital Asset Links.
6. In Play Console, complete store listing, data safety, privacy policy URL, content rating, testing track, and production rollout.

## Ads path

1. Apply for Google AdSense for the web domain. The site must be live, reachable, policy-compliant, and have enough unique content and useful navigation.
2. After AdSense approval, replace `ADSENSE_CLIENT_ID` and `ADSENSE_SLOTS.portfolioMobile` in `index.html` with the real `ca-pub-...` client and ad slot IDs.
3. Replace the commented template in `ads.txt` with the real AdSense publisher line.
4. For the Play Store app, create an AdMob app and ad unit. After the app appears in Google Play, replace the commented template in `app-ads.txt` with the real AdMob publisher line.
5. Keep the first ad placement light: one responsive banner in the portfolio area. Avoid interstitials until retention is proven.

## Owner inputs still required

- Google Play package name, for example `com.whaletracker.pro`.
- Android signing SHA-256 fingerprint, required for `assetlinks.json`.
- AdSense publisher ID and ad slot ID.
- AdMob app ID and ad unit IDs.

## Official references

- Android App Bundle: https://developer.android.com/guide/app-bundle/
- Trusted Web Activity: https://developer.android.com/develop/ui/views/layout/webapps/trusted-web-activities
- AdMob Android SDK: https://developers.google.com/admob/android/sdk
- AdSense site readiness: https://support.google.com/adsense/answer/12176698
- AdMob app-ads.txt: https://support.google.com/admob/answer/9363762
