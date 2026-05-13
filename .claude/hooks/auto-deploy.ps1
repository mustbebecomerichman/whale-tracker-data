# auto-deploy.ps1 — Claude Code Stop hook
#
# 동작 흐름 (Claude 응답 종료 시 자동 실행):
#   1. git status로 변경/추적 안된 파일 감지
#   2. 변경이 있으면 자동 커밋 (`Auto-commit: <files>` 메시지)
#   3. 현재 브랜치 origin으로 푸시
#   4. 브랜치에 열린 PR 찾기 → mergeable 상태 확인 → 자동 머지(main으로)
#   5. main 머지 시 Cloudflare Pages가 1~2분 후 자동 배포
#
# 안전장치:
#   - main/master 브랜치에서는 동작 안함 (보호)
#   - 변경 없으면 종료
#   - PR 없거나 mergeable=false면 푸시만 하고 종료
#   - 모든 단계 실패 시 다음 단계 시도 안함, exit 0 (Claude 흐름 방해 X)

$ErrorActionPreference = 'Continue'

# 표준 입력의 hook payload는 무시 (디버그 용도로만 보존)
try { $null = [Console]::In.ReadToEnd() } catch {}

function Log($msg) {
  $ts = Get-Date -Format 'HH:mm:ss'
  Write-Host "[auto-deploy $ts] $msg"
}

# ── 1. Repo root 확인 ───────────────────────────────────
$repoRoot = (& git rev-parse --show-toplevel 2>$null).Trim()
if (-not $repoRoot) { Log 'Not in a git repo, skip'; exit 0 }
Set-Location $repoRoot

# ── 2. 브랜치 보호 ──────────────────────────────────────
$branch = (& git rev-parse --abbrev-ref HEAD 2>$null).Trim()
if ($branch -eq 'main' -or $branch -eq 'master' -or $branch -eq 'HEAD') {
  Log "On '$branch' branch — auto-deploy skipped (protected)"
  exit 0
}

# ── 3. 변경 감지 + 커밋 ─────────────────────────────────
$status = (& git status --porcelain 2>$null)
$didCommit = $false
if ($status) {
  # 시크릿 파일 자동 제외 (이중 안전장치, .gitignore와 중복)
  $secretPatterns = @('secrets_local.py','serviceAccountKey.json','my_portfolio.json','whale_data.json','global_whales.json')
  $secretFound = $status | Where-Object {
    foreach ($p in $secretPatterns) { if ($_ -match [regex]::Escape($p)) { return $true } }
    return $false
  }
  if ($secretFound) {
    Log "Detected secret-looking file in changes — abort auto-commit:`n$secretFound"
    exit 0
  }

  Log 'Staging changes...'
  & git add -A 2>&1 | Out-Null

  $stagedFiles = (& git diff --cached --name-only) -split "`n" | Where-Object { $_ }
  if (-not $stagedFiles) { Log 'Nothing staged, exit'; exit 0 }

  $first = $stagedFiles | Select-Object -First 3
  $more  = if ($stagedFiles.Count -gt 3) { " (+$($stagedFiles.Count - 3) more)" } else { '' }
  $subject = 'Auto-commit: ' + ($first -join ', ') + $more

  $statSummary = (& git diff --cached --shortstat).Trim()
  $body = @"
Triggered by Claude Code Stop hook.

$statSummary

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>
"@

  Log "Commit: $subject"
  $tmp = New-TemporaryFile
  "$subject`n`n$body" | Set-Content -Path $tmp -Encoding utf8
  & git commit -F $tmp 2>&1 | ForEach-Object { Log $_ }
  Remove-Item $tmp -Force -ErrorAction SilentlyContinue
  if ($LASTEXITCODE -ne 0) { Log 'Commit failed (hook?), abort'; exit 0 }
  $didCommit = $true
}

# 변경 없어도 미푸시 커밋이 있으면 푸시 진행
$unpushed = (& git log "origin/$branch..HEAD" --oneline 2>$null)
if (-not $didCommit -and -not $unpushed) { Log 'No changes, no unpushed commits, exit'; exit 0 }

# ── 4. 푸시 ────────────────────────────────────────────
Log "Pushing $branch..."
& git push origin $branch 2>&1 | ForEach-Object { Log $_ }
if ($LASTEXITCODE -ne 0) { Log 'Push failed, exit'; exit 0 }

# ── 5. GitHub 토큰 추출 (credential helper) ──────────────
$credInput = "protocol=https`nhost=github.com`n`n"
$credOutput = $credInput | & git credential fill 2>$null
$token = $null
foreach ($line in $credOutput) {
  if ($line -like 'password=*') { $token = $line.Substring(9); break }
}
if (-not $token) { Log 'GitHub token unavailable, skip auto-merge'; exit 0 }

# ── 6. Repo owner/name 파싱 ─────────────────────────────
$remoteUrl = (& git remote get-url origin).Trim()
$m = [regex]::Match($remoteUrl, 'github\.com[:/]([^/]+)/([^/.]+?)(\.git)?$')
if (-not $m.Success) { Log "Cannot parse owner/repo from $remoteUrl"; exit 0 }
$owner = $m.Groups[1].Value
$repo = $m.Groups[2].Value

$headers = @{
  Authorization = "token $token"
  Accept = 'application/vnd.github.v3+json'
  'User-Agent' = 'Claude-AutoDeploy'
}

# ── 7. 브랜치 PR 찾기 ───────────────────────────────────
$prs = $null
try {
  $prs = Invoke-RestMethod -Uri "https://api.github.com/repos/$owner/$repo/pulls?head=${owner}:$branch&state=open" -Headers $headers
} catch { Log "PR lookup failed: $($_.Exception.Message)"; exit 0 }
if (-not $prs -or $prs.Count -eq 0) { Log "No open PR for $branch — push only"; exit 0 }
$pr = $prs[0]
Log "Found PR #$($pr.number) — $($pr.title)"

# ── 8. Mergeable 상태 폴링 (GitHub 비동기 계산) ──────────
for ($i = 0; $i -lt 10; $i++) {
  Start-Sleep -Seconds 2
  try {
    $fresh = Invoke-RestMethod -Uri "https://api.github.com/repos/$owner/$repo/pulls/$($pr.number)" -Headers $headers
  } catch { continue }
  if ($null -ne $fresh.mergeable) { $pr = $fresh; break }
}

if (-not $pr.mergeable) {
  Log "PR #$($pr.number) not mergeable (state: $($pr.mergeable_state)) — push complete, manual merge needed"
  exit 0
}

# ── 9. 머지 ───────────────────────────────────────────
Log "Merging PR #$($pr.number) into main..."
$mergeBody = @{
  merge_method = 'merge'
  commit_title = "Merge PR #$($pr.number): $($pr.title)"
} | ConvertTo-Json
try {
  $result = Invoke-RestMethod -Uri "https://api.github.com/repos/$owner/$repo/pulls/$($pr.number)/merge" -Method PUT -Headers $headers -Body $mergeBody -ContentType 'application/json'
  Log "Merged: $($result.sha) — Cloudflare Pages will deploy main in ~1-2 min"
} catch {
  Log "Merge API failed: $($_.Exception.Message)"
  exit 0
}

exit 0
