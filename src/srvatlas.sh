#!/bin/bash
#
# Name: "srvatlas.sh"
# Version: "0.1.1"
# Description: Atlas cluster name validator
# Authors: ["tap1r <luke.prochazka@gmail.com>"]

_domain="${1:?Usage: srvatlas.sh atlas-cluster-name}"
_txt=$(dig +short $_domain TXT)

echo -e "Validating Atlas cluster name:\t${_domain}"
echo -e "TXT resource record:\t\t$_txt"

for _srv in $(dig +short _mongodb._tcp.${_domain} SRV); do
  if [ "${_srv: -13}" = ".mongodb.net." ]; then
    echo -e "SRV resource record:\t\t${_srv}"
    echo -e "Resolves to CNAME/A record:\t$(dig +short ${_srv} A)"
  fi
done
