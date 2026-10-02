#!/bin/bash
# Replay the saved command transcripts through srvatlas.sh on bash 3.2.
# The transcripts use cluster.example.mongodb.net and 203.0.113.10.
set -u
D=$(cd "$(dirname "$0")" && pwd)
SCRIPT=$(cd "$D/.." && pwd)/srvatlas.sh
CLUSTER=cluster.example.mongodb.net
LOG=$D/.run-log
TMP=$D/.tmp
trap 'rm -f "$LOG" "$D/.out" "$D/.err"; rm -rf "$TMP"' EXIT
chmod +x "$D/bin/dig" "$D/bin/nc" "$D/bin/openssl" "$D/bin/mongosh"

fail() {
    echo "FAIL: $*"
    echo "----- stdout -----"
    cat "$D/.out" 2>/dev/null || true
    echo "----- stderr -----"
    cat "$D/.err" 2>/dev/null || true
    echo "----- calls -----"
    cat "$LOG" 2>/dev/null || true
    exit 1
}

run_case() {
    : >"$LOG"
    rm -rf "$TMP"
    mkdir -p "$TMP"
    SRVATLAS_CASE=$1 \
    SRVATLAS_FIXTURE_DIR=$D \
    SRVATLAS_LOG=$LOG \
    TMPDIR=$TMP \
    PATH="$D/bin:/usr/bin:/bin" \
        /bin/bash "$SCRIPT" "$CLUSTER" >"$D/.out" 2>"$D/.err"
    rc=$?
    left=$(find "$TMP" -mindepth 1 -print)
    [[ -z $left ]] || fail "$1 left files in TMPDIR: $left"
    rm -rf "$TMP"
}

/bin/bash -n "$SCRIPT" || fail "bash -n srvatlas.sh"
/bin/bash -n "$D/run.sh" || fail "bash -n run.sh"
for _stub in dig nc openssl mongosh; do
    /bin/bash -n "$D/bin/$_stub" || fail "bash -n $_stub"
done
if command -v shellcheck >/dev/null 2>&1; then
    shellcheck "$SCRIPT" "$D/run.sh" "$D/bin/dig" "$D/bin/nc" "$D/bin/openssl" "$D/bin/mongosh" \
        || fail "shellcheck"
    echo "OK: shellcheck"
else
    echo "OK: bash -n (ShellCheck is not installed)"
fi

run_case libressl
[[ $rc -eq 0 ]] || fail "libressl rc=$rc"
grep -q 'TCP connectivity:	open' "$D/.out" || fail "libressl nc open"
grep -q 'TLS protocol:		TLSv1.3' "$D/.out" || fail "libressl protocol"
grep -q 'TLS ciphersuite:	TLS_AES_128_GCM_SHA256' "$D/.out" || fail "libressl cipher"
grep -q 'TLS group:		P-256' "$D/.out" || fail "libressl group"
grep -q 'Complete!' "$D/.out" || fail "libressl complete"
grep 's_client ' "$LOG" | grep -q -- '-brief' && fail "libressl passed -brief"
grep 's_client ' "$LOG" | grep -q -- '-servername n0.cluster.example.mongodb.net ' \
    || fail "libressl SNI"
grep 's_client ' "$LOG" | grep -q -- '-servername n0.cluster.example.mongodb.net\.' \
    && fail "libressl trailing-dot SNI"
echo "OK: LibreSSL transcript and GNU nc open"

run_case alert50
[[ $rc -eq 1 ]] || fail "alert50 rc=$rc"
grep -q 'TLS was not established' "$D/.err" || fail "alert50 tls"
# The script prints the first hello line. The alert number stays in the
# transcript that hello_retryable and s_client_brief read.
grep -q 'tlsv1 alert decode error' "$D/.out" || fail "alert50 hello text"
grep -q $'TLS:\t\t\tdisabled' "$D/.out" || fail "alert50 tls state"
grep -q 'SSL alert number 50' "$D/tls-alert-50.txt" || fail "alert50 transcript"
[[ $(grep -c '^mongosh ' "$LOG") -eq 1 ]] || fail "alert50 retried hello"
[[ $(grep -c '^s_client ' "$LOG") -eq 5 ]] || fail "alert50 retried handshake"
echo "OK: TLS alert 50 is final"

run_case alert80
[[ $rc -eq 1 ]] || fail "alert80 rc=$rc"
grep -q 'TLS was not established' "$D/.err" || fail "alert80 tls"
grep -q 'tlsv1 alert internal error' "$D/.out" || fail "alert80 hello text"
grep -q $'TLS:\t\t\tdisabled' "$D/.out" || fail "alert80 tls state"
grep -q 'SSL alert number 80' "$D/tls-alert-80.txt" || fail "alert80 transcript"
[[ $(grep -c '^mongosh ' "$LOG") -eq 1 ]] || fail "alert80 retried hello"
[[ $(grep -c '^s_client ' "$LOG") -eq 5 ]] || fail "alert80 retried handshake"
echo "OK: TLS alert 80 is final"

run_case empty-srv
[[ $rc -eq 1 ]] || fail "empty-srv rc=$rc"
grep -q "ERROR: SRV lookup failed for _mongodb._tcp.${CLUSTER}, is it a valid cluster name?" "$D/.err" \
    || fail "empty-srv message"
grep -q 'retrying' "$D/.err" && fail "empty-srv retried"
[[ $(grep -c '^dig TXT' "$LOG") -eq 1 ]] || fail "empty-srv txt count"
[[ $(grep -c '^dig SRV' "$LOG") -eq 1 ]] || fail "empty-srv wave count"
[[ $(grep -c '^dig A n0' "$LOG") -eq 0 ]] || fail "empty-srv continued to hosts"
echo "OK: empty SRV exits on that wave"

run_case load-balanced
[[ $rc -eq 0 ]] || fail "load-balanced rc=$rc"
grep -q "Load-balanced endpoint detected: adding 'loadBalanced' and 'apiVersion' options" "$D/.out" \
    || fail "load-balanced notice"
grep -q 'unsupported_when_load_balanced' "$D/.out" || fail "load-balanced identity"
grep 'agreement:' "$D/.out" | grep -q 'ok' || fail "load-balanced agreement"
grep -q 'does not match SRV target' "$D/.err" && fail "load-balanced checked identity"
grep '^mongosh ' "$LOG" | grep -q 'loadBalanced=true' || fail "load-balanced uri"
grep '^mongosh ' "$LOG" | grep -q -- '--apiVersion 1' || fail "load-balanced apiVersion"
grep -q 'Complete!' "$D/.out" || fail "load-balanced complete"
echo "OK: load-balanced TXT"

echo "PASS"
