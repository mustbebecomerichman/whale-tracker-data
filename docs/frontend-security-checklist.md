# WhaleTracker Pro Frontend Security Checklist

Last updated: 2026-05-03

Use this checklist whenever `index.html`, `sw.js`, auth flow, ad code, or portfolio rendering changes.

## Required checks before deploy

```powershell
node -e "const fs=require('fs'); JSON.parse(fs.readFileSync('manifest.webmanifest','utf8')); console.log('manifest ok')"
node -e "const fs=require('fs'),vm=require('vm'); const html=fs.readFileSync('index.html','utf8'); [...html.matchAll(/<script(?![^>]*src=)[^>]*>([\s\S]*?)<\/script>/gi)].forEach((m,i)=>new vm.Script(m[1],{filename:'index-inline-'+i+'.js'})); console.log('inline scripts ok')"
git diff --check
```

## Update rules

- Treat anything from JSON import, Firestore, external APIs, query strings, and admin uploads as untrusted until escaped or assigned with `textContent`.
- Use `escapeHtml()` / `escapeAttr()` for template strings that become `innerHTML`, especially input `value`, names, notes, error messages, and API labels. Use `escapeJsAttr()` for values inserted into inline event-handler strings.
- Prefer `textContent`, `value`, `setAttribute`, and DOM creation for new UI. Use `innerHTML` only when markup is genuinely needed.
- Do not place KIS secrets, Firebase service credentials, AdSense secrets, or signing keys in frontend files. Public Firebase web config is acceptable only with Firestore rules and authorized domains kept tight.
- Keep API calls behind `apiFetch()` so Firebase ID tokens are attached.
- Keep Cloudflare Pages Functions protected by approved Google Firebase user verification and the trusted-origin allowlist.
- After changing Firebase/Auth/AdSense/AdMob scripts, check browser console for `Content-Security-Policy-Report-Only` warnings from `_headers`.
- If report-only CSP is clean across login, portfolio save/load, quote lookup, and ads, then consider moving more directives into the enforced `Content-Security-Policy`.

## Current security posture

- Firestore rules restrict portfolio and whale-data reads to approved Google users only.
- Pages Functions reject untrusted origins and require approved Google Firebase users.
- `_headers` adds `nosniff`, frame blocking, referrer policy, permissions policy, and a safe enforced CSP baseline.
- Full script/connect/frame policy is currently report-only to avoid breaking Google login or future ad tags during store preparation.
