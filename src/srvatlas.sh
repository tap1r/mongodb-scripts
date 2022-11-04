#!/usr/bin/env bash
# Name: "srvatlas.sh"
# Version: "0.4.4"
# Description: Atlas/SRV cluster name/connection validator
# Authors: ["tap1r <luke.prochazka@gmail.com>"]

_clusterName="${1:?'Usage: srvatlas.sh atlas-cluster-name'}"

### script defaults
#
# helper command dependencies
_shell='mongosh' # alternatively use the legacy mongo shell
_legacyShell='mongo' # required for network compression tests
_openssl='openssl'
_lookupCmd='dig' # nslookup doesn't support the +stats option
_networkCmd='nc'
# connection options
_shellOpts=('--norc' '--quiet') # add --tls if required
_connectTimeout=2 # seconds
_timeoutMS=$((_connectTimeout * 1000))
_uriOpts="appName=ndiag&connectTimeoutMS=${_timeoutMS}&serverSelectionTimeoutMS=${_timeoutMS}"
_authUser='local.__system' # defaults to on-prem use case
_cipherSuites=('tls1' 'tls1_1' 'tls1_2' 'tls1_3')
_tls1_3_suites='TLS_AES_256_GCM_SHA384:TLS_CHACHA20_POLY1305_SHA256:TLS_AES_128_GCM_SHA256' # OpenSSL default
_policy='HIGH:!EXPORT:!aNULL@STRENGTH' # MongoDB compiled default
_compressors='snappy,zstd,zlib' # MongoDB compiled default
_zlibLevel=-1
_lb=false # serverless testing

### main

# test the OpenSSL ABI
[[ -x $(which $_openssl) ]] || {
    echo -e "ERROR: OpenSSL binary $_openssl is NOT in \$PATH" 1>&2
    exit 1
}

[[ $($_openssl version) =~ ^OpenSSL ]] || {
    echo -e "WARNING: Unexpected OpenSSL binary $($_openssl version), results may vary" 1>&2
}

# test for valid mongo/mongosh shells
[[ -x $(which $_shell) ]] || {
    echo -e "WARNING: Shell $_shell is NOT in \$PATH, attempting to substitute for the legacy shell" 1>&2
    _shell=$_legacyShell
}

[[ -x $(which $_legacyShell) ]] || {
    echo -e "ERROR: Legacy shell $_legacyShell is NOT in \$PATH, a valid mongo shell is required" 1>&2
    exit 1
}

# DNS lookup binary test
[[ -x $(which $_lookupCmd) ]] || {
    echo -e "ERROR: $_lookupCmd is NOT in \$PATH" 1>&2
    exit 1
}

# network command binary test
[[ -x $(which $_networkCmd) ]] || {
    echo -e "ERROR: $_networkCmd is NOT in \$PATH" 1>&2
    exit 1
}

# verify if the supplied cluster-name is valid
_txt=$($_lookupCmd +short $_clusterName TXT)
_a=$($_lookupCmd +short $_clusterName A)
[[ ! -z $_txt ]] || {
    echo -e "ERROR: TXT lookup failed for $_clusterName, is it a valid cluster name?" 1>&2
    exit 1
}

[[ ! -z $_txt && -z $_a ]] || {
    echo -e "WARNING: record resolves to a valid host ${_a}, ensure the correct cluster name is used for SRV resolution" 1>&2
    exit 1
}

echo -e "\nValidating Atlas cluster name:\t$_clusterName"
echo -e "\n\tTXT resource record:\t$_txt"

while IFS=' ' read -a line; do
    for ((n=0; n<${#line[@]}; n+=4)); do
        _host=${line[$n+3]}
        _port=${line[$n+2]}
        _resolved=$($_lookupCmd +short $_host A)
        echo -e "\n\tSRV resource record:\t$_host"
        echo -e "\tResolves to CNAME/A:\t${_resolved//$'\n'/ / }"
        echo -e "\tService parameter:\tTCP/$_port"
        _targets+=(${_host%\.}:${_port})
    done
    break
done <<< $($_lookupCmd +short _mongodb._tcp.$_clusterName SRV)

# measure DNS latency of batched lookups
echo -e "\nDNS query latency:\n"
_totalQuery=0
_batchLatency=0
_queryRegex="Query time\: ([0-9]*) msec"
_txtQuery=$($_lookupCmd +stats $_clusterName TXT &)
_srvQuery=$($_lookupCmd +stats _mongodb._tcp.$_clusterName SRV &)
wait

[[ ${_txtQuery} =~ $_queryRegex ]] && {
    _txtLatency=${BASH_REMATCH[1]}
    echo -e "\tTXT query latency:\t${_txtLatency}ms"
}

[[ ${_srvQuery} =~ $_queryRegex ]] && {
    _srvLatency=${BASH_REMATCH[1]}
    echo -e "\tSRV query latency:\t${_srvLatency}ms"
}

while IFS=' ' read -a line; do
    for ((n=0; n<${#line[@]}; n+=4)); do
        _host=${line[$n+3]}
        _hostQuery=$($_lookupCmd +stats ${_host} A)
        [[ ${_hostQuery} =~ $_queryRegex ]] && {
            let "_totalQuery+=${BASH_REMATCH[1]}"
            _aLookups+=(${BASH_REMATCH[1]})
        }
    done
    break
done <<< $($_lookupCmd +short _mongodb._tcp.$_clusterName SRV)

IFS=$'\n'
_slowest=$(echo -e "${_aLookups[*]}" | sort -nr | head -n1)
echo -e "\tA query latency:\t${_slowest}ms (slowest A lookup)"
_batchLatency=$((_txtLatency + _srvLatency + _slowest))
echo -e "\n\tDNS batch latency:\t${_batchLatency}ms"
echo -e "\nDNS tests done.\n"

# detect Atlas namespace and add TLS + auth options
[[ ${_clusterName%\.} =~ \.mongodb\.net$ ]] && {
    echo "Atlas detected: adding TLS and Auth options"
    _shellOpts+=("--tls")
    _authUser="admin.mms-automation"
}

# detect Atlas serverless and add "loadBalanced=true" + "apiVersion=1" options
[[ ${_txt} =~ loadBalanced=true ]] && {
    echo "Atlas serverless detected: adding 'loadBalanced' and 'apiVersion' options"
    _shellOpts+=('--apiVersion 1')
    _uriOpts+="&loadBalanced=true"
    _lb=true
}

# detect open socket & detect TLS & detect mongod/mongos
echo -e "\nHost connectivity tests on: ${_targets[@]}"
for _target in ${_targets[@]}; do {
    _uri="mongodb://${_target}/?${_uriOpts}"
    _isTLSenabled=$(timeout $_connectTimeout $_openssl s_client -connect ${_target} -brief < /dev/null 2>&1 &)
    _isReachable=$($_networkCmd -zv -G ${_connectTimeout} ${_target%%:*}. ${_target##*:} 2>&1 &)
    _isMongos=$($_shell $_uri ${_shellOpts[@]} --eval 'db.hello().msg;' &)
    _isMongod=$($_shell $_uri ${_shellOpts[@]} --eval 'db.hello().hosts;' &)
    wait
    # _queryRegex="(MongoServerSelectionError\: Server selection timed out after [0-9]* ms)"
    _queryRegex="Connection.+(succeeded)"
    [[ ${_isReachable} =~ $_queryRegex ]] && _reachable=${BASH_REMATCH[1]}
    _queryRegex="CONNECTION (ESTABLISHED)"
    [[ ${_isTLSenabled} =~ $_queryRegex ]] && _tlsEnabled=${BASH_REMATCH[1]}
    echo -e "\n\tnode:\t\t\t${_target}\n\tTCP connectivity:\t${_reachable}\n\tTLS enablement:\t\t${_tlsEnabled}"
} # &
done
# wait

echo -e "\nEvaluating connection properties to individual nodes: ${_targets[@]}"
for _target in ${_targets[@]}; do {
    _uri="mongodb://${_target}/?${_uriOpts}"
    _saslCmd="db.runCommand({ \"hello\": 1, \"saslSupportedMechs\": \"${_authUser}\", \"comment\": \"run by ${0##*/}\" }).saslSupportedMechs;"
    _saslSupportedMechs=$($_shell "$_uri" ${_shellOpts[@]} --eval "$_saslCmd" &)
    _maxWireVersion=$($_shell "$_uri" ${_shellOpts[@]} --eval 'db.hello().maxWireVersion;' &)
    if ! $_lb; then
        _compressionMechs=$($_legacyShell "${_uri}&compressors=${_compressors}&zlibCompressionLevel=${_zlibLevel}" ${_shellOpts[@]} --eval 'db.hello().compression;' &)
    else
        _compressionMechs="unsupported_mongosh_test"
    fi

    wait
    echo -e "\n\tnode:\t\t\t$_target"
    echo -e "\tsaslSupportedMechs:\t${_saslSupportedMechs//[\[\] \'\"]/}"
    echo -e "\tcompression mechs:\t${_compressionMechs//[\[\] \'\"]/}"
    echo -e "\tmaxWireVersion:\t\t$_maxWireVersion"
    echo -e "\tTLS cipher scanning:";
    for _suite in ${_cipherSuites[@]}; do {
        _negotiatedCiphers="None"
        _ciphers=$($_openssl ciphers -s -$_suite -ciphersuites $_tls1_3_suites $_policy)
        for _cipher in ${_ciphers//:/ }; do
            timeout $_connectTimeout $_openssl s_client -connect "$_target" -cipher $_cipher -$_suite -async < /dev/null > /dev/null 2>&1 && _negotiatedCiphers+=($_cipher)
        done
        [[ ${#_negotiatedCiphers[@]} -gt 1 ]] && unset _negotiatedCiphers[0]
        echo -e "\n\t\t$_suite: ${_negotiatedCiphers[@]}"
        unset _negotiatedCiphers
    } # &
    done
    # wait
} # &
done
# wait

echo -e "\nConnectivity tests done."

# detect mongod/mongos and replset consistency
echo -e "\nReplica set consistency tests:"
for _target in "${_targets[@]}"; do {
    _uri="mongodb://${_target}/?${_uriOpts}"
    echo -e "\n\tEvaluating:\t$_target\n"
    if ! $_lb; then
        _identity=$($_shell $_uri ${_shellOpts[@]} --eval 'db.hello().me;' &)
    else
        _identity="unsupported_on_serverless"
    fi
    
    _rsHosts=$($_shell $_uri ${_shellOpts[@]} --eval 'db.hello().hosts;' &)
    _mongos=$($_shell $_uri ${_shellOpts[@]} --eval 'db.hello().msg;' &)
    wait
    [[ -n ${_rsHosts} ]] && _proc="mongod"
    [[ ${_mongos} == "isdbgrid" ]] && _proc="mongos"
    echo -e "\tHost type:\t${_proc}"
    echo -e "\tIdentity:\t${_identity}"
    if [[ "${_proc}" = "mongod" ]]; then
        _rsName=$($_shell $_uri ${_shellOpts[@]} --eval 'db.hello().setName;' &)
        _rsTags=$($_shell $_uri ${_shellOpts[@]} --eval 'db.hello().tags;' &)
        wait
        echo -e "\treplset name:\t${_rsName}"
        echo -e "\treplset hosts:\t${_rsHosts//[$'\n'\[\] \'\"]/}"
        echo -e "\treplset tags:\t${_rsTags//[$'\n' \'\"]/}"
    else
        echo -e "\tHost is of type ${_proc}, skipping replica set tests."
    fi
} # &
done
# wait

echo -e "\nReplica set tests done."

echo -e "\nComplete!\n"
