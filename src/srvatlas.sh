#!/bin/bash
#
# Name: "srvatlas.sh"
# Version: "0.3.4"
# Description: Atlas cluster name/connection validator
# Authors: ["tap1r <luke.prochazka@gmail.com>"]

_clusterName="${1:?Usage: srvatlas.sh atlas-cluster-name}"

#
# script defaults
#
_shell="mongosh" # alternatively use the legacy mongo shell
_legacyShell="mongo" # required for network compression tests
_shellOpts=("--norc" "--quiet") # add --tls if required
_openssl="openssl"
_lookupCmd="dig" # nslookup not implemented (yet)
_authUser="local.__system" # defaults to on-prem use case
_cipherSuites=('tls1' 'tls1_1' 'tls1_2' 'tls1_3')
_tls1_3_suites='TLS_AES_256_GCM_SHA384:TLS_CHACHA20_POLY1305_SHA256:TLS_AES_128_GCM_SHA256' # OpenSSL default
_policy='HIGH:!EXPORT:!aNULL@STRENGTH' # MongoDB compiled default
_compressors="snappy,zstd,zlib" # MongoDB compiled default

# test the OpenSSL ABI
[ -x $(which $_openssl) ] || {
    echo -e "ERROR: OpenSSL binary ${_openssl} is NOT in PATH" 1>&2
    exit 1
}
[[ $($_openssl version) =~ ^OpenSSL ]] || {
    echo -e "ERROR: Unexpected OpenSSL binary $($_openssl version)"
    exit 1
}

# test for valide mongo/mongosh shells
if [ ! -x $(which $_shell) ]; then
    echo -e "WARNING: Shell ${_shell} is NOT in PATH, attempting to substitute for the legacy shell"
    _shell=$_legacyShell
fi
[ -x $(which $_legacyShell) ] || {
    echo -e "ERROR: Legacy shell ${_legacyShell} is NOT in PATH" 1>&2
    exit 1
}

# DNS lookup binary test
[ -x $(which $_lookupCmd) ] || {
    echo -e "ERROR: ${_lookupCmd} is NOT in PATH" 1>&2
    exit 1
}

# verify if the supplied cluster-name is valid
_txt=$($_lookupCmd -r +short $_clusterName TXT)
_a=$($_lookupCmd -r +short $_clusterName A)
[ ! -z $_txt ] || {
    echo -e "ERROR: TXT lookup failed for ${_clusterName}, is it a valid cluster name?"
    exit 1
}
[[ ! -z $_txt && -z $_a ]] || {
    echo -e "WARNING: record resolves to a valid host ${_a}, ensure the correct cluster name is used for SRV resolution"
    exit 1
}

echo -e "\nValidating Atlas cluster name:\t${_clusterName}"
echo -e "\n\tTXT resource record:\t\t${_txt}"

while IFS=' ' read -a line; do
    for ((n=0; n<${#line[@]}; n+=4)); do
        _host=${line[$n+3]}
        _port=${line[$n+2]}
        echo -e "\n\tSRV resource record:\t\t${_host}"
        echo -e "\tResolves to CNAME/A record:\t$($_lookupCmd -r +short ${_host} A)"
        echo -e "\tService parameter: \t\tTCP/${_port}"
        _targets+=(${_host%\.}:${_port})
    done
    break
done <<< $($_lookupCmd -r +short _mongodb._tcp.${_clusterName} SRV)

# measure DNS latency of batched lookups
echo -e "\nDNS query latency:\n"
_queryRegex="Query time\: ([0-9]*) msec"
_txtQuery="$($_lookupCmd -r +stats $_clusterName TXT)"
_srvQuery="$($_lookupCmd -r +stats _mongodb._tcp.${_clusterName} SRV)"
_totalQuery=0

[[ ${_txtQuery} =~ $_queryRegex ]] && {
    echo -e "\tTXT query latency: ${BASH_REMATCH[1]}ms"
    let "_totalQuery+=${BASH_REMATCH[1]}"
}
[[ ${_srvQuery} =~ $_queryRegex ]] && {
    echo -e "\tSRV query latency: ${BASH_REMATCH[1]}ms"
    let "_totalQuery+=${BASH_REMATCH[1]}"
}

while IFS=' ' read -a line; do
    for ((n=0; n<${#line[@]}; n+=4)); do
        _host=${line[$n+3]}
        _hostQuery="$($_lookupCmd -r +stats ${_host} A)"
        [[ ${_hostQuery} =~ $_queryRegex ]] && {
            echo -e "\tA query latency: ${BASH_REMATCH[1]}ms"
            let "_totalQuery+=${BASH_REMATCH[1]}"
        }
    done
    break
done <<< $($_lookupCmd -r +short _mongodb._tcp.${_clusterName} SRV)

echo -e "\n\tTotal DNS query latency: ${_totalQuery}ms\n"

echo -e "\nDNS tests done.\n"

# detect Atlas namespace and add TLS and auth options
[[ ${_clusterName%\.} =~ \.mongodb\.net$ ]] && {
    echo "Atlas detected: adding '--tls' and auth options"
    _shellOpts+=("--tls")
    _authUser="admin.mms-automation"
}

echo -e "\nValidating replSet consistency:\n"

for _target in "${_targets[@]}"; do
    _uri="mongodb://${_target}/?directConnection=true&appName=srvatlas.sh"
    echo -e "Evaluating ${_target}\n"
    echo -e "\tIdentity hello().me:\t$(${_shell} ${_uri} ${_shellOpts[@]} --eval 'db.hello().me')" &
    echo -e "\treplset name:\t\t$(${_shell} ${_uri} ${_shellOpts[@]} --eval 'db.hello().setName')" &
    echo -e "\treplset hosts:\n$(${_shell} ${_uri} ${_shellOpts[@]} --eval 'db.hello().hosts')" &
    echo -e "\treplset tags:\n$(${_shell} ${_uri} ${_shellOpts[@]} --eval 'db.hello().tags')" &
    wait
done

echo -e "\nReplica Set tests done."

echo -e "\nValidating connectivity to individual nodes:"

for _target in "${_targets[@]}"; do
    _uri="mongodb://${_target}/?directConnection=true&appName=srvatlas.sh"
    _saslCmd="db.runCommand({'hello':1,'saslSupportedMechs':'${_authUser}'}).saslSupportedMechs"
    echo -e "\nEvaluating $_target\n"
    echo -e "\tsaslSupportedMechs:\t$(${_shell} ${_uri} ${_shellOpts[@]} --eval ${_saslCmd})" &
    echo -e "\tcompression mechanisms:\t$(${_legacyShell} ${_uri}\&compressors=${_compressors} ${_shellOpts[@]} --eval 'db.hello().compression')" &
    echo -e "\tmaxWireVersion:\t$(${_shell} ${_uri} ${_shellOpts[@]} --eval 'db.hello().maxWireVersion')" &
    wait
    echo -e "\tTLS cipher scanning:";
    for _suite in ${_cipherSuites[@]}; do {
        _ciphers="None"
        for _cipher in $(${_openssl} ciphers -s -${_suite} -ciphersuites ${_tls1_3_suites} ${_policy} | tr ':' ' '); do
            ${_openssl} s_client -connect "${_target}" -cipher $_cipher -$_suite < /dev/null > /dev/null 2>&1 && _ciphers+=($_cipher)
        done
        [[ ${#_ciphers[@]} -gt 1 ]] && unset _ciphers[0]
        echo -e "\n\t${_suite}: ${_ciphers[@]}"
        unset _ciphers
    } &
    done
    wait
done

echo -e "\nConnectivity tests done.\n"
