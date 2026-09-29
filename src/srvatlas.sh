#!/usr/bin/env bash
# Name: "srvatlas.sh"
# Version: "0.6.0"
# Description: Atlas/SRV cluster name/connection validator
# Disclaimer: https://raw.githubusercontent.com/tap1r/mongodb-scripts/master/DISCLAIMER.md
# Authors: ["tap1r <luke.prochazka@gmail.com>"]
#
# Usage: "bash srvatlas.sh [--ciphers] <atlas-cluster-name>"
# --ciphers  handshake every local cipher for tls1, tls1_1, tls1_2, and tls1_3

_usage='Usage: srvatlas.sh [--ciphers] <atlas-cluster-name>'
_cipherScan=false
_clusterName=
for _arg in "$@"; do
    case $_arg in
        --ciphers) _cipherScan=true ;;
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
_shellOpts=('--norc' '--quiet') # add --tls if required
_connectTimeout=2 # seconds, TCP connect and server selection
_handshakeTimeout=$((_connectTimeout * 3)) # TLS handshake; RTT can exceed the TCP connect timeout
_timeoutMS=$((_connectTimeout * 1000))
_uriOpts="appName=ndiag&connectTimeoutMS=${_timeoutMS}&serverSelectionTimeoutMS=${_timeoutMS}"
_authUser='local.__system' # defaults to on-prem use case
_cipherSuites=('tls1' 'tls1_1' 'tls1_2' 'tls1_3')
_tls1_3_suites='TLS_AES_256_GCM_SHA384:TLS_CHACHA20_POLY1305_SHA256:TLS_AES_128_GCM_SHA256' # OpenSSL default
_policy='HIGH:!EXPORT:!aNULL@STRENGTH' # MongoDB compiled default
_compressors='snappy,zstd,zlib' # MongoDB compiled default
_zlibLevel=-1
_lb=false # serverless testing
_expectTls=false # set when the namespace profile requires TLS
_failures=0
_txtReplicaSet=
_targets=()
_srvHosts=()

check_openssl() {
    # test the OpenSSL ABI
    [[ -x $(which $_openssl) ]] || {
        echo -e "ERROR: OpenSSL binary $_openssl is NOT in \$PATH" 1>&2
        exit 1
    }

    [[ $($_openssl version) =~ ^OpenSSL ]] || {
        echo -e "WARNING: Unexpected OpenSSL binary $($_openssl version), results may vary" 1>&2
    }
}

check_shells() {
    # test for valid mongo/mongosh shells
    [[ -x $(which $_shell) ]] || {
        echo -e "WARNING: Shell $_shell is NOT in \$PATH, attempting to substitute for the legacy shell" 1>&2
        _shell=$_legacyShell
        [[ -x $(which $_legacyShell) ]] || {
            echo -e "ERROR: Legacy shell $_legacyShell is NOT in \$PATH, a valid mongo shell is required" 1>&2
            exit 1
        }
    }
}

check_lookup_cmd() {
    # DNS lookup binary test
    [[ -x $(which $_lookupCmd) ]] || {
        echo -e "ERROR: $_lookupCmd is NOT in \$PATH" 1>&2
        exit 1
    }
}

check_network_cmd() {
    # network command binary test
    [[ -x $(which $_networkCmd) ]] || {
        echo -e "ERROR: $_networkCmd is NOT in \$PATH" 1>&2
        exit 1
    }
}

validate_cluster_name() {
    # verify if the supplied cluster-name is valid
    local _n _host _port _resolved _line

    _txt=$("$_lookupCmd" +short "$_clusterName" TXT)
    _a=$("$_lookupCmd" +short "$_clusterName" A)
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
            [[ -n $_host && -n $_port ]] || continue
            _resolved=$("$_lookupCmd" +short "$_host" A)
            echo -e "\n\tSRV resource record:\t$_host"
            echo -e "\tResolves to CNAME/A:\t${_resolved//$'\n'/ / }"
            echo -e "\tService parameter:\tTCP/$_port"
            _targets+=("${_host%\.}:${_port}")
            _srvHosts+=("$_host")
        done
    done <<< "$("$_lookupCmd" +short "_mongodb._tcp.${_clusterName}" SRV)"

    [[ ${#_targets[@]} -gt 0 ]] || {
        echo -e "ERROR: SRV lookup failed for _mongodb._tcp.${_clusterName}, is it a valid cluster name?" 1>&2
        exit 1
    }
}

measure_dns_latency() {
    # measure DNS latency of batched lookups
    local _srvHost _hostQuery

    echo -e "\nDNS query latency:\n"
    _totalQuery=0
    _batchLatency=0
    _aLookups=()
    _queryRegex="Query time\: ([0-9]*) msec"
    _txtQuery=$("$_lookupCmd" +stats "$_clusterName" TXT &)
    _srvQuery=$("$_lookupCmd" +stats "_mongodb._tcp.${_clusterName}" SRV &)
    wait

    [[ ${_txtQuery} =~ $_queryRegex ]] && {
        _txtLatency=${BASH_REMATCH[1]}
        echo -e "\tTXT query latency:\t${_txtLatency}ms"
    }

    [[ ${_srvQuery} =~ $_queryRegex ]] && {
        _srvLatency=${BASH_REMATCH[1]}
        echo -e "\tSRV query latency:\t${_srvLatency}ms"
    }

    for _srvHost in "${_srvHosts[@]}"; do
        _hostQuery=$("$_lookupCmd" +stats "$_srvHost" A)
        [[ ${_hostQuery} =~ $_queryRegex ]] && {
            let "_totalQuery+=${BASH_REMATCH[1]}"
            _aLookups+=("${BASH_REMATCH[1]}")
        }
    done

    _slowest=$(printf '%s\n' "${_aLookups[@]}" | sort -nr | head -n1)
    echo -e "\tA query latency:\t${_slowest}ms (slowest A lookup)"
    _batchLatency=$((_txtLatency + _srvLatency + _slowest))
    echo -e "\n\tDNS batch latency:\t${_batchLatency}ms"
    echo -e "\nDNS tests done.\n"
}

apply_atlas_namespace() {
    # detect Atlas namespace and add TLS + auth options
    [[ ${_clusterName%\.} =~ \.mongodb\.net$ ]] && {
        echo "Atlas detected: adding TLS and Auth options"
        _shellOpts+=("--tls")
        _authUser="admin.mms-automation"
        _expectTls=true
    }
}

apply_serverless_options() {
    # detect Atlas serverless and add "loadBalanced=true" + "apiVersion=1" options
    [[ ${_txt} =~ loadBalanced=true ]] && {
        echo "Atlas serverless detected: adding 'loadBalanced' and 'apiVersion' options"
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
    # mongosh inspect prints arrays on multiple lines, and the hello command
    # reply has no compression field. Read the compressors the server accepted
    # on the handshake from the driver connection description.
    local _probeUri _helloEval _row _key _val

    _probeUri="${_uri}&compressors=${_compressors}&zlibCompressionLevel=${_zlibLevel}"
    _identity=
    _mongos=
    _rsHosts=
    _rsName=
    _rsTags=
    _saslSupportedMechs=
    _compressionMechs=
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
let comps = [];
try {
  const client = db.getMongo()._serviceProvider.mongoClient;
  client.topology.s.servers.forEach(function (srv) {
    const conn = srv.monitor && srv.monitor.connection;
    const list = conn && conn.description && conn.description.compressors;
    if (Array.isArray(list) && list.length) comps = list;
  });
} catch (e) {}
show("COMP", comps.join(","));
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
            COMP) _compressionMechs=$_val ;;
        esac
    done <<< "$_helloOut"
}

read_tls_brief() {
    # OpenSSL s_client -brief reports the one negotiated protocol and ciphersuite.
    local _text=$1
    _tlsProtocol=
    _tlsCipher=
    [[ $_text =~ Protocol\ version:\ ([^[:space:]]+) ]] && _tlsProtocol=${BASH_REMATCH[1]}
    [[ $_text =~ Ciphersuite:\ ([^[:space:]]+) ]] && _tlsCipher=${BASH_REMATCH[1]}
}

build_cipher_lists() {
    # The local cipher list does not depend on the target. Build it once per run.
    local _suite _raw
    _ciphersTls1=
    _ciphersTls11=
    _ciphersTls12=
    _ciphersTls13=
    for _suite in "${_cipherSuites[@]}"; do
        _raw=$("$_openssl" ciphers -s "-$_suite" -ciphersuites "$_tls1_3_suites" "$_policy" 2>/dev/null || true)
        case $_suite in
            tls1) _ciphersTls1=$_raw ;;
            tls1_1) _ciphersTls11=$_raw ;;
            tls1_2) _ciphersTls12=$_raw ;;
            tls1_3) _ciphersTls13=$_raw ;;
        esac
    done
}

cipher_list_for() {
    case $1 in
        tls1) printf '%s' "$_ciphersTls1" ;;
        tls1_1) printf '%s' "$_ciphersTls11" ;;
        tls1_2) printf '%s' "$_ciphersTls12" ;;
        tls1_3) printf '%s' "$_ciphersTls13" ;;
    esac
}

test_host_connectivity() {
    # detect open socket & detect TLS
    local _target

    echo -e "\nHost connectivity tests on: ${_targets[@]}"
    for _target in "${_targets[@]}"; do {
        _uri="mongodb://${_target}/?${_uriOpts}"
        _reachable=
        _tlsEnabled=
        _tlsProtocol=
        _tlsCipher=
        _isTLSenabled=$(run_deadline "$_handshakeTimeout" "$_openssl" s_client -connect "${_target}" -brief </dev/null 2>&1)
        _isReachable=$("$_networkCmd" -zv -G "$_connectTimeout" "${_target%%:*}." "${_target##*:}" 2>&1)
        _queryRegex="Connection.+(succeeded)"
        [[ ${_isReachable} =~ $_queryRegex ]] && _reachable=${BASH_REMATCH[1]}
        _queryRegex="CONNECTION (ESTABLISHED)"
        [[ ${_isTLSenabled} =~ $_queryRegex ]] && _tlsEnabled=${BASH_REMATCH[1]}
        read_tls_brief "$_isTLSenabled"
        echo -e "\n\tnode:\t\t\t${_target}\n\tTCP connectivity:\t${_reachable}\n\tTLS enablement:\t\t${_tlsEnabled}\n\tTLS protocol:\t\t${_tlsProtocol}\n\tTLS ciphersuite:\t${_tlsCipher}"
        [[ $_reachable == succeeded ]] || note_failure "TCP connectivity failed for ${_target}"
        if $_expectTls; then
            [[ $_tlsEnabled == ESTABLISHED ]] || note_failure "TLS was not established for ${_target}"
        fi
    } # &
    done
    # wait
}

evaluate_connection_properties() {
    local _target _suite _cipher _tlsFlags

    _helloMe=()
    _helloMsg=()
    _helloHosts=()
    _helloSet=()
    _helloTags=()
    _helloOk=()
    if $_cipherScan; then
        echo -e "\nEnumerating local TLS ciphers (--ciphers). This probes every suite on every node."
        build_cipher_lists
    fi
    echo -e "\nEvaluating connection properties to individual nodes: ${_targets[@]}"
    for _target in "${_targets[@]}"; do {
        _uri="mongodb://${_target}/?${_uriOpts}"
        collect_hello
        if $_lb; then
            _identity="unsupported_on_serverless"
        fi
        _helloMe+=("$_identity")
        _helloMsg+=("$_mongos")
        _helloHosts+=("$_rsHosts")
        _helloSet+=("$_rsName")
        _helloTags+=("$_rsTags")
        _helloOk+=("$_ok")
        echo -e "\n\tnode:\t\t\t$_target"
        echo -e "\tsaslSupportedMechs:\t${_saslSupportedMechs}"
        echo -e "\tcompression mechs:\t${_compressionMechs}"
        echo -e "\tmaxWireVersion:\t\t$_maxWireVersion"
        if [[ $_ok != 1 ]]; then
            echo -e "\thello:\t\t\t${_err:-${_helloOut%%$'\n'*}}"
            note_failure "hello failed for ${_target}${_err:+: ${_err}}"
        fi
        if $_cipherScan; then
            echo -e "\tTLS cipher scanning:";
            for _suite in "${_cipherSuites[@]}"; do {
                _negotiatedCiphers="None"
                _ciphers=$(cipher_list_for "$_suite")
                if [[ $_suite == tls1_3 ]]; then
                    _tlsFlags=(-tls1_3)
                else
                    _tlsFlags=("-$_suite")
                fi
                for _cipher in ${_ciphers//:/ }; do
                    [[ -n $_cipher ]] || continue
                    if [[ $_suite == tls1_3 ]]; then
                        run_deadline "$_handshakeTimeout" "$_openssl" s_client -connect "$_target" "${_tlsFlags[@]}" -ciphersuites "$_cipher" -async </dev/null >/dev/null 2>&1 && _negotiatedCiphers+=("$_cipher")
                    else
                        run_deadline "$_handshakeTimeout" "$_openssl" s_client -connect "$_target" "${_tlsFlags[@]}" -cipher "$_cipher" -async </dev/null >/dev/null 2>&1 && _negotiatedCiphers+=("$_cipher")
                    fi
                done
                [[ ${#_negotiatedCiphers[@]} -gt 1 ]] && unset '_negotiatedCiphers[0]'
                echo -e "\n\t\t$_suite: ${_negotiatedCiphers[@]}"
                unset _negotiatedCiphers
            } # &
            done
            # wait
        fi
    } # &
    done
    # wait

    echo -e "\nConnectivity tests done."
}

test_replset_consistency() {
    # detect mongod/mongos and replset consistency
    local _target _i=0 _srv _nodeAgree

    echo -e "\nReplica set consistency tests:"
    [[ -n $_txtReplicaSet ]] && echo -e "\tTXT replicaSet:\t${_txtReplicaSet}"
    for _target in "${_targets[@]}"; do {
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
    } # &
    done
    # wait

    echo -e "\nReplica set tests done."
}

main() {
    check_openssl
    check_shells
    check_lookup_cmd
    check_network_cmd
    validate_cluster_name
    measure_dns_latency
    apply_atlas_namespace
    apply_serverless_options
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
