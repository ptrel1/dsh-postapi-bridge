#!/usr/bin/env bash
# dsh-postapi-bridge 溯源审计验证脚本（v0.3.0）
# 用法：./test/postapi_audit_test.sh <baseURL> [token]
set -euo pipefail
BASE="${1:?用法: $0 <baseURL> [token]}"
TOKEN="${2:-}"
CURL_AUTH=()
[ -n "$TOKEN" ] && CURL_AUTH=(-H "X-Gateway-Token: $TOKEN")
echo "== 1) health（应返回 audited:true，含 accessLog 路径）=="
curl -s -m 5 "${BASE}/health" | python3 -m json.tool || true
echo
echo "== 2) 不带通道标识的 /task（UA 推断为 curl）=="
R1=$(curl -s -m 90 -X POST "${BASE}/task" -H "Content-Type: application/json" -H "X-DSH-Channel: test-plain" --data '{"prompt":"只回答两个字符 ok"}')
echo "$R1"; echo
echo "== 3) 带通道+伪造 XFF 的 /task（模拟公网入口，channel=maibot, ip取XFF首跳）=="
R2=$(curl -s -m 90 -X POST "${BASE}/task" -H "Content-Type: application/json" -H "X-DSH-Channel: maibot" -H "X-Forwarded-For: 203.0.113.9, 10.0.0.5" --data '{"prompt":"只回答两个字符 ok"}')
echo "$R2"; echo
echo "== 4) 查看审计日志（request/result 成对，四要素齐全）=="
LOG="$(dirname "$0")/../data/access-log.jsonl"
[ -f "$LOG" ] && tail -8 "$LOG" || echo "（未生成 access-log.jsonl）"