#!/bin/bash
set -euo pipefail

nic=$(route -n get default | grep "interface" | awk '{print $2}')

hardware_port=$(networksetup -listnetworkserviceorder | awk -v dev="$nic" '
    /^\([0-9]+\) /{port=$0; sub(/^\([0-9]+\) /, "", port)} 
    /\(Hardware Port:/{interface=$NF;sub(/\)/, "", interface); if (interface == dev) {print port; exit}}
')

if [ -z "$hardware_port" ]; then
    echo "failed to resolve network service for interface $nic" >&2
    exit 1
fi

if [ -f .original_dns.txt ]; then
    original_dns=$(cat .original_dns.txt)
    if [ "$original_dns" = "empty" ]; then
        networksetup -setdnsservers "$hardware_port" Empty
    else
        # shellcheck disable=SC2086
        networksetup -setdnsservers "$hardware_port" $original_dns
    fi
    rm -f .original_dns.txt
fi
