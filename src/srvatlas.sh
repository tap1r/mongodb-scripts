#!/usr/bin/env bash
# Name: "srvatlas.sh"
# Version: "0.7.5"
# Description: Atlas/SRV cluster name/connection validator
# Disclaimer: https://raw.githubusercontent.com/tap1r/mongodb-scripts/master/DISCLAIMER.md
# Authors: ["tap1r <luke.prochazka@gmail.com>"]
#
# Usage: "bash srvatlas.sh [--ciphers] [--tls|--plaintext] <cluster-name>"
# Each node lists the TLS versions it negotiates and every cipher that completed a handshake.
# --ciphers    try every local cipher one at a time for tls1, tls1_1, tls1_2, and tls1_3
# --tls        on-prem: connect with TLS. Atlas always uses TLS.
# --plaintext  on-prem: connect without TLS. Not valid for Atlas.

_usage='Usage: srvatlas.sh [--ciphers] [--tls|--plaintext] <cluster-name>'
_cipherScan=false
_transport=
_clusterName=
for _arg in "$@"; do
    case $_arg in
        --ciphers) _cipherScan=true ;;
        --tls)
            [[ $_transport == plaintext ]] && { echo "$_usage" 1>&2; exit 1; }
            _transport=tls
            ;;
        --plaintext)
            [[ $_transport == tls ]] && { echo "$_usage" 1>&2; exit 1; }
            _transport=plaintext
            ;;
        -*)
            echo "$_usage" 1>&2
            exit 1
            ;;
        *)
            if [[ -n $_clusterName ]]; then
                echo "$_usage" 1>&2
                exit 1
            fi
            _clusterName=$_arg
            ;;
    esac
done
[[ -n $_clusterName ]] || {
    echo "$_usage" 1>&2
    exit 1
}

### script defaults
#
# helper command dependencies
_shell='mongosh' # alternatively use the legacy mongo shell
_legacyShell='mongo' # fallback when mongosh is absent
_openssl='openssl'
_lookupCmd='dig' # nslookup doesn't support the +stats option
_networkCmd='nc'
# connection options
_shellOpts=('--norc' '--quiet') # --tls is added after the transport probe
_connectTimeout=2 # seconds, TCP connect and server selection
_handshakeTimeout=$((_connectTimeout * 3)) # TLS handshake; RTT can exceed the TCP connect timeout
_timeoutMS=$((_connectTimeout * 1000))
_uriOpts="appName=ndiag&connectTimeoutMS=${_timeoutMS}&serverSelectionTimeoutMS=${_timeoutMS}"
_authUser='local.__system' # defaults to on-prem use case
_cipherSuites=('tls1' 'tls1_1' 'tls1_2' 'tls1_3')
_policy='HIGH:!EXPORT:!aNULL@STRENGTH' # MongoDB compiled default
_compressors='snappy,zstd,zlib' # MongoDB compiled default
_zlibLevel=-1
_lb=false # load-balanced SRV endpoint
_profile=onprem
_expectTls=false # Atlas requires TLS; on-prem probes plaintext and TLS
_transportChosen=plaintext
_failures=0
_txtReplicaSet=
_targets=()
_srvHosts=()
_libressl=false
_ncTimeoutFlag=-G

have_cmd() {
    local _bin
    _bin=$(command -v "$1" 2>/dev/null || true)
    [[ -n $_bin && -x $_bin ]]
}

tcp_open() {
    # macOS nc says "succeeded". GNU nc says "open".
    [[ $1 == succeeded || $1 == open ]]
}

check_openssl() {
    # test the OpenSSL ABI
    local _ver=
    have_cmd "$_openssl" || {
        echo -e "ERROR: OpenSSL binary $_openssl is NOT in \$PATH" 1>&2
        exit 1
    }

    _libressl=false
    _ver=$("$_openssl" version)
    if [[ $_ver =~ ^LibreSSL ]]; then
        # s_client -brief is an OpenSSL option. LibreSSL rejects it.
        _libressl=true
    elif [[ ! $_ver =~ ^OpenSSL ]]; then
        echo -e "WARNING: Unexpected OpenSSL binary $_ver, results may vary" 1>&2
    fi
}

check_shells() {
    # test for valid mongo/mongosh shells
    have_cmd "$_shell" || {
        echo -e "WARNING: Shell $_shell is NOT in \$PATH, attempting to substitute for the legacy shell" 1>&2
        _shell=$_legacyShell
        have_cmd "$_legacyShell" || {
            echo -e "ERROR: Legacy shell $_legacyShell is NOT in \$PATH, a valid mongo shell is required" 1>&2
            exit 1
        }
    }
}

check_lookup_cmd() {
    # DNS lookup binary test
    have_cmd "$_lookupCmd" || {
        echo -e "ERROR: $_lookupCmd is NOT in \$PATH" 1>&2
        exit 1
    }
}

check_network_cmd() {
    # network command binary test
    # macOS nc takes -G for the connect timeout. GNU nc takes -w and rejects -G.
    have_cmd "$_networkCmd" || {
        echo -e "ERROR: $_networkCmd is NOT in \$PATH" 1>&2
        exit 1
    }
    if "$_networkCmd" -h 2>&1 | grep -q -- '-G'; then
        _ncTimeoutFlag=-G
    else
        _ncTimeoutFlag=-w
    fi
}

normalize_cluster_name() {
    # Dig and the shells receive this name. Allow only a hostname, then strip
    # every trailing dot. Lookups add exactly one so the name is absolute.
    [[ $_clusterName =~ ^[A-Za-z0-9.-]+$ ]] || {
        echo -e "ERROR: cluster name must contain only letters, digits, dots, and hyphens" 1>&2
        exit 1
    }
    local _name="$_clusterName"
    while [[ $_name == *. ]]; do
        _name=${_name%.}
    done
    [[ -n $_name ]] || {
        echo -e "ERROR: cluster name is empty" 1>&2
        exit 1
    }
    _clusterName=$_name
}

validate_cluster_name() {
    # verify if the supplied cluster-name is valid
    local _n _host _port _resolved _line

    _txt=$("$_lookupCmd" +short "${_clusterName}." TXT)
    _a=$("$_lookupCmd" +short "${_clusterName}." A)
    [[ -n $_txt ]] || {
        echo -e "ERROR: TXT lookup failed for $_clusterName, is it a valid cluster name?" 1>&2
        exit 1
    }

    # An A record on the SRV name is optional. Atlas omits it so a non-SRV hostname fails closed.
    [[ -z $_a ]] || {
        echo -e "WARNING: ${_clusterName} also has an A record (${_a//$'\n'/, }). mongodb+srv bootstrap does not require its absence." 1>&2
    }

    echo -e "\nValidating Atlas cluster name:\t$_clusterName"
    echo -e "\n\tTXT resource record:\t$_txt"
    _txtReplicaSet=
    [[ $_txt =~ replicaSet=([^&\"]+) ]] && _txtReplicaSet=${BASH_REMATCH[1]}

    _targets=()
    _srvHosts=()
    while IFS=' ' read -r -a _line; do
        for ((_n=0; _n+3<${#_line[@]}; _n+=4)); do
            _host=${_line[_n+3]}
            _port=${_line[_n+2]}
            while [[ $_host == *. ]]; do
                _host=${_host%.}
            done
            [[ -n $_host && -n $_port ]] || continue
            _resolved=$("$_lookupCmd" +short "${_host}." A)
            echo -e "\n\tSRV resource record:\t${_host}."
            echo -e "\tResolves to CNAME/A:\t${_resolved//$'\n'/ / }"
            echo -e "\tService parameter:\tTCP/$_port"
            _targets+=("${_host}:${_port}")
            _srvHosts+=("${_host}.")
        done
    done <<< "$("$_lookupCmd" +short "_mongodb._tcp.${_clusterName}." SRV)"

    [[ ${#_targets[@]} -gt 0 ]] || {
        echo -e "ERROR: SRV lookup failed for _mongodb._tcp.${_clusterName}, is it a valid cluster name?" 1>&2
        exit 1
    }
}

measure_dns_latency() {
    # Time one +stats pass. TXT runs with SRV, then the per-host A lookups run
    # together. The batch line is the wall-clock of those two waves. Each sample
    # is dig's own Query time. Jobs start in this shell: a command substitution
    # waits for its own background dig, so $(dig … &) does not overlap.
    local _srvHost _hostQuery _dir _i _pid _n
    local _txtFile _srvFile _txtPid _srvPid _t0 _t1
    local -a _aPids

    echo -e "\nDNS query latency:\n"
    _batchLatency=0
    _aLookups=()
    _txtLatency=
    _srvLatency=
    _slowest=
    _queryRegex='Query time: ([0-9]+) msec'
    # The cluster name and the SRV name are absolute. Each _srvHosts entry already ends in one dot.
    _dir=$(mktemp -d "${TMPDIR:-/tmp}/srvatlas-dns.XXXXXX") || return
    _txtFile="${_dir}/txt"
    _srvFile="${_dir}/srv"
    _t0=$(perl -MTime::HiRes=time -e 'printf "%d", time * 1000' 2>/dev/null || python3 -c 'import time; print(int(time.time() * 1000))')

    "$_lookupCmd" +stats "${_clusterName}." TXT >"$_txtFile" 2>&1 </dev/null &
    _txtPid=$!
    "$_lookupCmd" +stats "_mongodb._tcp.${_clusterName}." SRV >"$_srvFile" 2>&1 </dev/null &
    _srvPid=$!
    wait "$_txtPid"
    wait "$_srvPid"

    _aPids=()
    _i=0
    for _srvHost in "${_srvHosts[@]}"; do
        "$_lookupCmd" +stats "$_srvHost" A >"${_dir}/a${_i}" 2>&1 </dev/null &
        _aPids+=("$!")
        _i=$((_i + 1))
    done
    for _pid in "${_aPids[@]}"; do
        wait "$_pid"
    done

    _t1=$(perl -MTime::HiRes=time -e 'printf "%d", time * 1000' 2>/dev/null || python3 -c 'import time; print(int(time.time() * 1000))')
    [[ $_t0 =~ ^[0-9]+$ ]] || _t0=0
    [[ $_t1 =~ ^[0-9]+$ ]] || _t1=0
    if [[ $_t1 -ge $_t0 ]]; then
        _batchLatency=$((_t1 - _t0))
    fi

    _txtQuery=$(<"${_txtFile}")
    [[ $_txtQuery =~ $_queryRegex ]] && _txtLatency=${BASH_REMATCH[1]}
    _srvQuery=$(<"${_srvFile}")
    [[ $_srvQuery =~ $_queryRegex ]] && _srvLatency=${BASH_REMATCH[1]}
    _n=${#_srvHosts[@]}
    _i=0
    while [[ $_i -lt $_n ]]; do
        _hostQuery=$(<"${_dir}/a${_i}")
        [[ $_hostQuery =~ $_queryRegex ]] && _aLookups+=("${BASH_REMATCH[1]}")
        _i=$((_i + 1))
    done
    rm -rf "$_dir"

    [[ -n $_txtLatency ]] && echo -e "\tTXT query latency:\t${_txtLatency}ms"
    [[ -n $_srvLatency ]] && echo -e "\tSRV query latency:\t${_srvLatency}ms"
    _slowest=$(printf '%s\n' "${_aLookups[@]}" | sort -nr | head -n1)
    [[ -n $_slowest ]] && echo -e "\tA query latency:\t${_slowest}ms (slowest A lookup)"
    echo -e "\n\tDNS batch latency:\t${_batchLatency}ms"
    echo -e "\nDNS tests done.\n"
}

apply_profile() {
    # Atlas TLS is mandatory. On-prem plaintext and TLS are both optional.
    local _name=${_clusterName%.}
    _profile=onprem
    _expectTls=false
    if [[ $_name =~ \.mongodbgov\.net$ ]]; then
        _profile=atlas-gov
    elif [[ $_name =~ \.mongodb\.net$ ]]; then
        _profile=atlas
    fi
    if [[ $_profile == atlas || $_profile == atlas-gov ]]; then
        _expectTls=true
        _authUser="admin.mms-automation"
        if [[ $_transport == plaintext ]]; then
            echo "ERROR: Atlas TLS is mandatory; --plaintext is not valid for ${_profile}" 1>&2
            exit 1
        fi
        echo "Profile: ${_profile} (TLS mandatory)"
    else
        echo "Profile: onprem (plaintext and TLS are probed; both may be enabled)"
    fi
}

apply_load_balanced_options() {
    # detect a load-balanced SRV name and add "loadBalanced=true" + "apiVersion=1" options
    [[ ${_txt} =~ loadBalanced=true ]] && {
        echo "Load-balanced endpoint detected: adding 'loadBalanced' and 'apiVersion' options"
        _shellOpts+=('--apiVersion' '1')
        _uriOpts+="&loadBalanced=true"
        _lb=true
    }
}

note_failure() {
    echo -e "ERROR: $*" 1>&2
    _failures=$((_failures + 1))
}

list_has() {
    local _haystack=$1 _needle=$2 _item
    local IFS=','
    for _item in $_haystack; do
        [[ $_item == "$_needle" ]] && return 0
    done
    return 1
}

run_deadline() {
    # GNU timeout is not installed on macOS. Bound a probe with timeout, gtimeout, or perl.
    local _secs=$1
    shift
    if command -v timeout >/dev/null 2>&1; then
        command timeout "$_secs" "$@"
        return
    fi
    if command -v gtimeout >/dev/null 2>&1; then
        command gtimeout "$_secs" "$@"
        return
    fi
    if command -v perl >/dev/null 2>&1; then
        perl -e '
            my $t = shift;
            my $pid = fork();
            exit 127 unless defined $pid;
            if ($pid == 0) { exec @ARGV or exit 127; }
            $SIG{ALRM} = sub { kill 15, $pid; waitpid($pid, 0); exit 124; };
            alarm $t;
            waitpid($pid, 0);
            my $st = $?;
            exit 128 + ($st & 127) if ($st & 127);
            exit($st >> 8);
        ' "$_secs" "$@"
        return
    fi
    "$@"
}

collect_hello() {
    # The hello command reply has no compression field. The handshake hello on
    # the connection description does: hello.compression is the server's answer,
    # and description.compressor is the one name it picked. description.compressors
    # is only the list this client offered.
    local _probeUri _helloEval _row _key _val

    _probeUri="${_uri}&compressors=${_compressors}&zlibCompressionLevel=${_zlibLevel}"
    _identity=
    _mongos=
    _rsHosts=
    _rsName=
    _rsTags=
    _saslSupportedMechs=
    _saslField=
    _compRead=
    _serverComp=
    _chosenComp=
    _unsupportedComp=
    _maxWireVersion=
    _ok=
    _err=
    _helloOut=
    _helloEval=$(cat <<EOF
const h = db.runCommand({
  hello: 1,
  saslSupportedMechs: "${_authUser}",
  comment: "run by ${0##*/}"
});
function show(k, v) {
  if (v == null) v = "";
  print(k + "=" + v);
}
show("OK", h.ok);
show("ERR", h.errmsg || "");
show("ME", h.me || "");
show("MSG", h.msg || "");
show("SET", h.setName || "");
show("WIRE", h.maxWireVersion == null ? "" : h.maxWireVersion);
show("HOSTS", (h.hosts || []).join(","));
const tags = h.tags || {};
const tagParts = Object.keys(tags).map(function (k) { return k + ":" + tags[k]; });
show("TAGS", tagParts.length ? "{" + tagParts.join(",") + "}" : "");
show("SASL", (h.saslSupportedMechs || []).join(","));
show("SASL_FIELD", h.saslSupportedMechs == null ? "missing" : "present");
function clientCan(name) {
  if ("${_shell}" === "mongo") return name === "snappy" || name === "zlib" || name === "zstd";
  if (name === "zlib") return typeof zlib !== "undefined";
  var mod = name === "snappy" ? "snappy" : (name === "zstd" ? "@mongodb-js/zstd" : "");
  if (!mod) return false;
  try { require(mod); return true; } catch (e) { return false; }
}
function walkConns(list, fn) {
  if (!list) return;
  if (typeof list.forEach === "function") { list.forEach(fn); return; }
  var node = list.head;
  var guard = 0;
  while (node && guard < 32) {
    fn(node.value != null ? node.value : node);
    node = node.next;
    guard++;
  }
}
var serverComp = [];
var chosen = "";
var read = "miss";
try {
  var client = db.getMongo()._serviceProvider.mongoClient;
  client.topology.s.servers.forEach(function (srv) {
    function note(desc) {
      if (!desc) return;
      var server = desc.hello && desc.hello.compression;
      if (Array.isArray(server) && server.length) serverComp = server;
      if (desc.compressor) chosen = desc.compressor;
    }
    var mon = srv.monitor && srv.monitor.connection;
    if (mon) note(mon.description);
    var pool = srv.pool;
    if (!pool) return;
    walkConns(pool.connections, function (conn) { note(conn && conn.description); });
    walkConns(pool.checkedOut, function (conn) { note(conn && conn.description); });
  });
  read = "ok";
} catch (e) {}
var unsupported = [];
function consider(name) {
  if (!name || clientCan(name)) return;
  var i;
  for (i = 0; i < unsupported.length; i++) if (unsupported[i] === name) return;
  unsupported.push(name);
}
var si;
for (si = 0; si < serverComp.length; si++) consider(serverComp[si]);
consider(chosen);
show("COMP_READ", read);
show("SERVER_COMP", serverComp.join(","));
show("CHOSEN", chosen);
show("UNSUPPORTED", unsupported.join(","));
EOF
)
    _helloOut=$("$_shell" "$_probeUri" "${_shellOpts[@]}" --eval "$_helloEval" 2>&1)
    while IFS= read -r _row; do
        [[ $_row == *=* ]] || continue
        _key=${_row%%=*}
        _val=${_row#*=}
        case $_key in
            OK) _ok=$_val ;;
            ERR) _err=$_val ;;
            ME) _identity=$_val ;;
            MSG) _mongos=$_val ;;
            SET) _rsName=$_val ;;
            WIRE) _maxWireVersion=$_val ;;
            HOSTS) _rsHosts=$_val ;;
            TAGS) _rsTags=$_val ;;
            SASL) _saslSupportedMechs=$_val ;;
            SASL_FIELD) _saslField=$_val ;;
            COMP_READ) _compRead=$_val ;;
            SERVER_COMP) _serverComp=$_val ;;
            CHOSEN) _chosenComp=$_val ;;
            UNSUPPORTED) _unsupportedComp=$_val ;;
        esac
    done <<< "$_helloOut"
}

read_tls_brief() {
    # OpenSSL s_client -brief reports the one negotiated protocol, ciphersuite, and group.
    # LibreSSL prints the classic transcript: "Protocol  :", "Cipher is", and "Server Temp Key".
    # TLS 1.3 suite names do not include the curve. The group line is the ECC (or hybrid) key exchange.
    local _text=$1 _cipher=
    _tlsProtocol=
    _tlsCipher=
    _tlsGroup=
    if [[ $_text =~ Protocol\ version:\ ([^[:space:]]+) ]]; then
        _tlsProtocol=${BASH_REMATCH[1]}
    elif [[ $_text =~ Protocol[[:space:]]*:[[:space:]]*([^[:space:]]+) ]]; then
        _tlsProtocol=${BASH_REMATCH[1]}
    fi
    if [[ $_text =~ Ciphersuite:\ ([^[:space:]]+) ]]; then
        _tlsCipher=${BASH_REMATCH[1]//$'\r'/}
    elif [[ $_text =~ Cipher\ is\ ([^[:space:]]+) ]]; then
        _cipher=${BASH_REMATCH[1]//$'\r'/}
        [[ $_cipher == '(NONE)' ]] || _tlsCipher=$_cipher
    elif [[ $_text =~ Cipher[[:space:]]*:[[:space:]]*([^[:space:]]+) ]]; then
        _cipher=${BASH_REMATCH[1]//$'\r'/}
        [[ $_cipher == '(NONE)' || $_cipher == 0000 ]] || _tlsCipher=$_cipher
    fi
    if [[ $_text =~ Negotiated\ TLS1\.[0-9]\ group:\ ([^[:space:]]+) ]]; then
        _tlsGroup=${BASH_REMATCH[1]//$'\r'/}
    elif [[ $_text =~ Peer\ Temp\ Key:\ ECDH,\ ([^,]+) ]]; then
        _tlsGroup=${BASH_REMATCH[1]//$'\r'/}
    elif [[ $_text =~ Peer\ Temp\ Key:\ ([^,]+), ]]; then
        _tlsGroup=${BASH_REMATCH[1]//$'\r'/}
    elif [[ $_text =~ Server\ Temp\ Key:\ ECDH,[[:space:]]*([^,[:space:]]+) ]]; then
        _tlsGroup=${BASH_REMATCH[1]//$'\r'/}
    fi
}

tls_session_ok() {
    # -brief says CONNECTION ESTABLISHED. The classic transcript says "Cipher is <name>".
    # A refused handshake still prints CONNECTED and "Cipher is (NONE)".
    local _flat=${1//$'\n'/ } _cipher=
    [[ $_flat == *'CONNECTION ESTABLISHED'* ]] && return 0
    [[ $_flat =~ Cipher\ is\ ([^[:space:]]+) ]] || return 1
    _cipher=${BASH_REMATCH[1]}
    [[ $_cipher != '(NONE)' && $_cipher != 0000 ]]
}

colon_has() {
    local _list=$1 _needle=$2 _item
    local IFS=:
    for _item in $_list; do
        [[ $_item == "$_needle" ]] && return 0
    done
    return 1
}

drop_colon_item() {
    local _list=$1 _drop=$2 _item _rest
    local IFS=:
    for _item in $_list; do
        [[ -z $_item || $_item == "$_drop" ]] && continue
        _rest+="${_rest:+:}$_item"
    done
    printf '%s' "$_rest"
}

merge_colon() {
    local _base=$1 _extra=$2 _item
    local IFS=:
    for _item in $_extra; do
        [[ $_item == TLS_* ]] || continue
        colon_has "$_base" "$_item" || _base+="${_base:+:}$_item"
    done
    printf '%s' "$_base"
}

build_cipher_lists() {
    # The local cipher list does not depend on the target. Build it once per run.
    # OpenSSL 4 has no TLS 1.4. TLS 1.3 is wire version 0x0304. Add tls1_4 only if this binary has the flag.
    # TLS 1.0 and 1.1 have no ciphers at the default security level, so those probes lower it and let the server refuse.
    local _suite _raw _policyFor _ccm _has14=false
    for _suite in "${_cipherSuites[@]}"; do
        [[ $_suite == tls1_4 ]] && _has14=true
    done
    if ! $_has14 && "$_openssl" s_client -help 2>&1 | grep -q -- '-tls1_4'; then
        _cipherSuites+=('tls1_4')
    fi
    _ciphersTls1=
    _ciphersTls11=
    _ciphersTls12=
    _ciphersTls13=
    _ciphersTls14=
    for _suite in "${_cipherSuites[@]}"; do
        _policyFor=$_policy
        [[ $_suite == tls1 || $_suite == tls1_1 ]] && _policyFor="${_policy}:@SECLEVEL=0"
        if [[ $_suite == tls1_3 || $_suite == tls1_4 ]]; then
            _raw=$("$_openssl" ciphers -s "-$_suite" 2>/dev/null || true)
            _ccm=$("$_openssl" ciphers -s "-$_suite" -ciphersuites 'TLS_AES_128_CCM_SHA256:TLS_AES_128_CCM_8_SHA256' 2>/dev/null || true)
            _raw=$(merge_colon "$_raw" "$_ccm")
        else
            _raw=$("$_openssl" ciphers -s "-$_suite" "$_policyFor" 2>/dev/null || true)
        fi
        case $_suite in
            tls1) _ciphersTls1=$_raw ;;
            tls1_1) _ciphersTls11=$_raw ;;
            tls1_2) _ciphersTls12=$_raw ;;
            tls1_3) _ciphersTls13=$_raw ;;
            tls1_4) _ciphersTls14=$_raw ;;
        esac
    done
}

build_group_candidates() {
    # ECC key exchange is a TLS group, not a TLS 1.3 ciphersuite name.
    # Keep the NIST curves, X25519/X448, and the hybrid groups this OpenSSL can offer.
    local _all _g
    local IFS=:
    _groupCandidates=()
    _all=$("$_openssl" list -tls-groups 2>/dev/null || true)
    _all=${_all//$'\n'/}
    for _g in $_all; do
        case $_g in
            x25519|X25519|x448|X448|secp256r1|secp384r1|secp521r1|prime256v1|X25519MLKEM768|SecP256r1MLKEM768|SecP384r1MLKEM1024)
                _groupCandidates+=("$_g")
                ;;
        esac
    done
}

cipher_list_for() {
    case $1 in
        tls1) printf '%s' "$_ciphersTls1" ;;
        tls1_1) printf '%s' "$_ciphersTls11" ;;
        tls1_2) printf '%s' "$_ciphersTls12" ;;
        tls1_3) printf '%s' "$_ciphersTls13" ;;
        tls1_4) printf '%s' "$_ciphersTls14" ;;
    esac
}

tls_endpoint() {
    # $1 is host:port with no trailing dot.
    # Connect to the absolute name. Pass the bare name as SNI.
    # Atlas aborts a server name that ends in a dot (TLS alert 50).
    local _host=${1%%:*}
    _connectTo="${_host}.:${1##*:}"
    _serverName=$_host
}

mongo_uri() {
    # $1 is host:port with no trailing dot. $2 is the query string.
    # The URI host is absolute for getaddrinfo. servername is the bare host:
    # that value is the TLS SNI, and hello.me has no trailing dot.
    local _host=${1%%:*} _port=${1##*:}
    printf 'mongodb://%s.:%s/?%s&servername=%s' "$_host" "$_port" "$2" "$_host"
}

s_client_invoke() {
    # LibreSSL s_client has no -brief. The classic transcript is the handshake result.
    if $_libressl; then
        run_deadline "$_handshakeTimeout" "$_openssl" s_client "$@" </dev/null 2>&1
    else
        run_deadline "$_handshakeTimeout" "$_openssl" s_client "$@" -brief </dev/null 2>&1
    fi
}

s_client_brief() {
    # A dropped handshake is not an empty cipher list.
    # Retry a reset or a timeout once. An alert is the server's answer, so it is not retried.
    local _try=0 _out= _rc=0 _flat=
    while [[ $_try -lt 2 ]]; do
        _try=$((_try + 1))
        _rc=0
        _out=$(s_client_invoke "$@") || _rc=$?
        _flat=${_out//$'\n'/ }
        tls_session_ok "$_out" && break
        [[ $_flat == *'alert protocol version'* || $_flat == *'alert handshake failure'* || $_flat == *'alert internal error'* ]] && break
        [[ $_rc -eq 124 || -z $_flat || $_flat == *'Connection reset'* || $_flat == *'unexpected eof'* ]] || break
        [[ $_try -lt 2 ]] && sleep 1
    done
    printf '%s\n' "$_out"
}

scan_negotiated_ciphers() {
    # Offer every local cipher for this version. Record the one the server picks, then offer the rest.
    # The result is the full set that negotiates, including ECDHE suites, in server preference order.
    local _target=$1 _suite=$2 _offer _wire _brief _picked _next _guard=0
    tls_endpoint "$_target"
    _negotiatedList=
    _offer=$(cipher_list_for "$_suite")
    [[ -n $_offer ]] || return
    while [[ -n $_offer && $_guard -lt 64 ]]; do
        _guard=$((_guard + 1))
        _wire=$_offer
        # Names were listed at SECLEVEL=0. The handshake has to allow them or OpenSSL drops TLS 1.0/1.1 locally.
        [[ $_suite == tls1 || $_suite == tls1_1 ]] && _wire="${_offer}:@SECLEVEL=0"
        if [[ $_suite == tls1_3 || $_suite == tls1_4 ]]; then
            _brief=$(s_client_brief -connect "$_connectTo" -servername "$_serverName" "-$_suite" -ciphersuites "$_wire")
        else
            _brief=$(s_client_brief -connect "$_connectTo" -servername "$_serverName" "-$_suite" -cipher "$_wire")
        fi
        tls_session_ok "$_brief" || break
        read_tls_brief "$_brief"
        _picked=$_tlsCipher
        colon_has "$_offer" "$_picked" || break
        _negotiatedList+="${_negotiatedList:+ }$_picked"
        _next=$(drop_colon_item "$_offer" "$_picked")
        [[ $_next == "$_offer" ]] && break
        _offer=$_next
    done
}

scan_each_local_cipher() {
    # --ciphers: one handshake per local cipher. Slower than peeling the server's choice off the offer.
    local _target=$1 _suite=$2 _cipher _ciphers _wire
    tls_endpoint "$_target"
    _negotiatedList=
    _ciphers=$(cipher_list_for "$_suite")
    for _cipher in ${_ciphers//:/ }; do
        [[ -n $_cipher ]] || continue
        _wire=$_cipher
        [[ $_suite == tls1 || $_suite == tls1_1 ]] && _wire="${_cipher}:@SECLEVEL=0"
        if [[ $_suite == tls1_3 || $_suite == tls1_4 ]]; then
            run_deadline "$_handshakeTimeout" "$_openssl" s_client -connect "$_connectTo" -servername "$_serverName" "-$_suite" -ciphersuites "$_wire" -async </dev/null >/dev/null 2>&1 \
                && _negotiatedList+="${_negotiatedList:+ }$_cipher"
        else
            run_deadline "$_handshakeTimeout" "$_openssl" s_client -connect "$_connectTo" -servername "$_serverName" "-$_suite" -cipher "$_wire" -async </dev/null >/dev/null 2>&1 \
                && _negotiatedList+="${_negotiatedList:+ }$_cipher"
        fi
    done
}

probe_ecc_groups() {
    # A TLS 1.3 ciphersuite does not name a curve. Probe the ECC and hybrid groups directly.
    local _target=$1 _suiteName _g _brief
    tls_endpoint "$_target"
    _negotiatedGroups=
    _suiteName=${_negotiatedList%% *}
    [[ -n $_suiteName && ${#_groupCandidates[@]} -gt 0 ]] || return
    for _g in "${_groupCandidates[@]}"; do
        _brief=$(s_client_brief -connect "$_connectTo" -servername "$_serverName" -tls1_3 -groups "$_g" -ciphersuites "$_suiteName")
        tls_session_ok "$_brief" && _negotiatedGroups+="${_negotiatedGroups:+ }$_g"
    done
}

probe_plaintext() {
    # A plaintext ping is independent of the TLS handshake.
    # allowTLS and preferTLS enable both; requireTLS enables TLS only.
    # tls=false keeps the probe off the TLS path. The printed token is split
    # so an echoed eval source cannot look like a successful ping.
    # directConnection hits this SRV target; loadBalanced rejects that pair.
    local _target=$1 _probeUri _out
    _plaintext=disabled
    _probeUri=$(mongo_uri "$_target" "appName=ndiag&connectTimeoutMS=${_timeoutMS}&serverSelectionTimeoutMS=${_timeoutMS}&directConnection=true&tls=false")
    _out=$(run_deadline "$_handshakeTimeout" "$_shell" "$_probeUri" "${_shellOpts[@]}" --eval 'const r=db.runCommand({ping:1}); if (r && r.ok==1) print("PLAINTEXT=" + "enabled");' 2>&1 || true)
    [[ ${_out//$'\n'/ } == *PLAINTEXT=enabled* ]] && _plaintext=enabled
}

select_transport() {
    # Atlas always uses TLS. On-prem prefers TLS when every reachable node offers it.
    _useTls=false
    if $_expectTls || [[ $_transport == tls ]]; then
        _useTls=true
    elif [[ $_transport == plaintext ]]; then
        _useTls=false
    elif [[ $_tcpUp -gt 0 && $_tlsUp -eq $_tcpUp ]]; then
        _useTls=true
    elif [[ $_tcpUp -gt 0 && $_plainUp -eq $_tcpUp ]]; then
        _useTls=false
    elif [[ $_tlsUp -gt 0 ]]; then
        _useTls=true
    fi
    if $_useTls; then
        _shellOpts+=("--tls")
        _transportChosen=tls
    else
        _transportChosen=plaintext
    fi
    echo -e "\nTransport: ${_transportChosen}"
}

test_host_connectivity() {
    # detect open socket, plaintext, and TLS
    local _target _tlsState _flat= _openRe=

    _tcpUp=0
    _tlsUp=0
    _plainUp=0
    echo -e "\nHost connectivity tests on: ${_targets[@]}"
    # Serial on purpose. Hello and TLS results are globals shared across nodes.
    for _target in "${_targets[@]}"; do
        _uri=$(mongo_uri "$_target" "$_uriOpts")
        _reachable=
        _tlsEnabled=
        _tlsProtocol=
        _tlsCipher=
        _tlsGroup=
        _plaintext=
        tls_endpoint "$_target"
        # nc takes the host and port separately. The trailing dot keeps that lookup absolute.
        _isReachable=$("$_networkCmd" -zv "$_ncTimeoutFlag" "$_connectTimeout" "${_target%%:*}." "${_target##*:}" 2>&1)
        _flat=${_isReachable//$'\n'/ }
        _openRe='(^|[^[:alnum:]])open([^[:alnum:]]|$)'
        if [[ $_flat =~ succeeded ]]; then
            _reachable=succeeded
        elif [[ $_flat =~ $_openRe ]]; then
            _reachable=open
        fi
        if tcp_open "$_reachable"; then
            _isTLSenabled=$(s_client_invoke -connect "$_connectTo" -servername "$_serverName") || true
            tls_session_ok "$_isTLSenabled" && _tlsEnabled=ESTABLISHED
            read_tls_brief "$_isTLSenabled"
            probe_plaintext "$_target"
            _tcpUp=$((_tcpUp + 1))
            [[ $_tlsEnabled == ESTABLISHED ]] && _tlsUp=$((_tlsUp + 1))
            [[ $_plaintext == enabled ]] && _plainUp=$((_plainUp + 1))
            _tlsState=disabled
            [[ $_tlsEnabled == ESTABLISHED ]] && _tlsState=enabled
        else
            _plaintext=skipped
            _tlsState=skipped
        fi
        echo -e "\n\tnode:\t\t\t${_target}\n\tTCP connectivity:\t${_reachable}\n\tplaintext:\t\t${_plaintext}\n\tTLS:\t\t\t${_tlsState}"
        if [[ $_tlsEnabled == ESTABLISHED ]]; then
            echo -e "\tTLS protocol:\t\t${_tlsProtocol}\n\tTLS ciphersuite:\t${_tlsCipher}\n\tTLS group:\t\t${_tlsGroup}"
        fi
        tcp_open "$_reachable" || note_failure "TCP connectivity failed for ${_target}"
        if $_expectTls; then
            [[ $_tlsEnabled == ESTABLISHED ]] || note_failure "TLS was not established for ${_target}"
        elif tcp_open "$_reachable" && [[ $_transport == tls && $_tlsEnabled != ESTABLISHED ]]; then
            note_failure "TLS was not established for ${_target}"
        elif tcp_open "$_reachable" && [[ $_transport == plaintext && $_plaintext != enabled ]]; then
            note_failure "plaintext is not enabled for ${_target}"
        elif tcp_open "$_reachable" && [[ -z $_transport && $_tlsEnabled != ESTABLISHED && $_plaintext != enabled ]]; then
            note_failure "neither plaintext nor TLS is enabled for ${_target}"
        fi
    done
    select_transport
}

evaluate_connection_properties() {
    local _target _suite

    _helloMe=()
    _helloMsg=()
    _helloHosts=()
    _helloSet=()
    _helloTags=()
    _helloOk=()
    if $_cipherScan; then
        echo -e "\nEnumerating local TLS ciphers (--ciphers). This probes every suite on every node."
    fi
    build_cipher_lists
    build_group_candidates
    echo -e "\nEvaluating connection properties to individual nodes: ${_targets[@]}"
    # Serial on purpose. _ok and the negotiated-cipher list are globals shared across nodes.
    for _target in "${_targets[@]}"; do
        _uri=$(mongo_uri "$_target" "$_uriOpts")
        collect_hello
        [[ $_ok == 1 ]] || collect_hello
        if $_lb; then
            _identity="unsupported_when_load_balanced"
        fi
        _helloMe+=("$_identity")
        _helloMsg+=("$_mongos")
        _helloHosts+=("$_rsHosts")
        _helloSet+=("$_rsName")
        _helloTags+=("$_rsTags")
        _helloOk+=("$_ok")
        echo -e "\n\tnode:\t\t\t$_target"
        echo -e "\tsaslSupportedMechs:\t${_saslSupportedMechs}"
        if [[ $_ok == 1 && $_saslField == missing ]]; then
            echo -e "\t\t${_authUser} is not visible to an unauthenticated hello"
        fi
        if [[ $_ok == 1 && $_compRead != ok ]]; then
            echo -e "\tcompression:\t\thandshake description unread"
        elif [[ $_ok == 1 && -n $_serverComp ]]; then
            echo -e "\tcompression:\t\t${_serverComp}"
        elif [[ $_ok == 1 ]]; then
            echo -e "\tcompression:\t\thello named no compressor"
        fi
        if [[ $_ok == 1 && $_compRead == ok ]]; then
            echo -e "\tchosen compressor:\t${_chosenComp}"
            if [[ -n $_unsupportedComp ]]; then
                echo -e "\tcompression client:\tserver accepted ${_unsupportedComp}; this shell cannot use it"
            fi
        fi
        echo -e "\tmaxWireVersion:\t\t$_maxWireVersion"
        if [[ $_ok != 1 ]]; then
            echo -e "\thello:\t\t\t${_err:-${_helloOut%%$'\n'*}}"
            note_failure "hello failed for ${_target}${_err:+: ${_err}}"
        fi
        echo -e "\tTLS cipher scanning:"
        for _suite in "${_cipherSuites[@]}"; do
            if $_cipherScan; then
                scan_each_local_cipher "$_target" "$_suite"
            else
                scan_negotiated_ciphers "$_target" "$_suite"
            fi
            echo -e "\n\t\t$_suite: ${_negotiatedList:-None}"
            if [[ $_suite == tls1_3 || $_suite == tls1_4 ]] && [[ -n $_negotiatedList ]]; then
                probe_ecc_groups "$_target"
                echo -e "\n\t\tgroups: ${_negotiatedGroups:-None}"
            fi
        done
    done

    echo -e "\nConnectivity tests done."
}

test_replset_consistency() {
    # detect mongod/mongos and replset consistency
    local _target _i=0 _srv _nodeAgree

    echo -e "\nReplica set consistency tests:"
    [[ -n $_txtReplicaSet ]] && echo -e "\tTXT replicaSet:\t${_txtReplicaSet}"
    # Serial on purpose. The hello record is read one target at a time.
    for _target in "${_targets[@]}"; do
        _proc=
        _identity=${_helloMe[_i]}
        _mongos=${_helloMsg[_i]}
        _rsHosts=${_helloHosts[_i]}
        _rsName=${_helloSet[_i]}
        _rsTags=${_helloTags[_i]}
        echo -e "\n\tEvaluating:\t$_target\n"
        [[ -n ${_rsHosts} ]] && _proc="mongod"
        [[ ${_mongos} == "isdbgrid" ]] && _proc="mongos"
        echo -e "\tHost type:\t${_proc}"
        echo -e "\tIdentity:\t${_identity}"
        if [[ "${_proc}" = "mongod" ]]; then
            echo -e "\treplset name:\t${_rsName}"
            echo -e "\treplset hosts:\t${_rsHosts}"
            echo -e "\treplset tags:\t${_rsTags}"
        else
            echo -e "\tHost is of type ${_proc}."
        fi
        if [[ ${_helloOk[_i]} != 1 ]]; then
            echo -e "\tagreement:\tskipped"
        else
            _nodeAgree=1
            if [[ $_proc == mongod && -n $_txtReplicaSet && $_rsName != "$_txtReplicaSet" ]]; then
                note_failure "${_target} replset name '${_rsName:-empty}' does not match TXT replicaSet '${_txtReplicaSet}'"
                _nodeAgree=0
            fi
            if ! $_lb; then
                if [[ $_identity != "$_target" ]]; then
                    note_failure "${_target} identity '${_identity:-empty}' does not match SRV target '${_target}'"
                    _nodeAgree=0
                fi
                if [[ -n $_rsHosts ]]; then
                    for _srv in "${_targets[@]}"; do
                        list_has "$_rsHosts" "$_srv" || {
                            note_failure "${_target} replset hosts do not include SRV target '${_srv}'"
                            _nodeAgree=0
                        }
                    done
                elif [[ $_proc == mongod ]]; then
                    note_failure "${_target} replset hosts are empty"
                    _nodeAgree=0
                fi
            fi
            if [[ $_nodeAgree -eq 1 ]]; then
                echo -e "\tagreement:\tok"
            else
                echo -e "\tagreement:\tfailed"
            fi
        fi
        _i=$((_i + 1))
    done

    echo -e "\nReplica set tests done."
}

main() {
    normalize_cluster_name
    check_openssl
    check_shells
    check_lookup_cmd
    check_network_cmd
    apply_profile
    validate_cluster_name
    measure_dns_latency
    apply_load_balanced_options
    test_host_connectivity
    evaluate_connection_properties
    test_replset_consistency
    if [[ $_failures -gt 0 ]]; then
        echo -e "\n${_failures} required check(s) failed.\n" 1>&2
        exit 1
    fi
    echo -e "\nComplete!\n"
}

main
