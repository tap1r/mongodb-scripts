#!/bin/bash
#
# Name: "srvatlas.sh"
# Version = "0.1.0"
# Description: Atlas SRV record validator
# Authors: ["tap1r <luke.prochazka@gmail.com>"]

_domain="${1:?Usage: srv.sh atlas-srv-name}"
_txt=$(dig +short $_domain TXT)

echo "Validating Atlas SRV records for ${_domain}"
echo -e "TXT resource record:\t$_txt"

for _srv in $(dig +short _mongodb._tcp.${_domain} SRV); do
  if [ "${_srv: -13}" = ".mongodb.net." ]; then
    echo "SRV resource record: ${_srv}"
    echo "Resolves to CNAME/A record:"
    echo "$(dig +short ${_srv} A)"
  fi
done
