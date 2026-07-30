#!/usr/bin/env python3
# Demo/dev presence beacon for the Ubuntu mesh (a stand-in until `lbabus net` runs on the actors).
# Broadcasts a UDP presence line on the mesh so the host viewers (mesh-monitor.mjs + capture.ps1) can be
# demonstrated on REAL host-only traffic. NOT the production coordination transport — that is `lbabus net`.
#
#   python3 presence-beacon.py <actor-name> [udp_port] [count] [broadcast-addr]
import socket, sys, time

name = sys.argv[1] if len(sys.argv) > 1 else "actor"
port = int(sys.argv[2]) if len(sys.argv) > 2 else 8777
count = int(sys.argv[3]) if len(sys.argv) > 3 else 60
bcast = sys.argv[4] if len(sys.argv) > 4 else "192.168.56.255"

s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
s.setsockopt(socket.SOL_SOCKET, socket.SO_BROADCAST, 1)
for i in range(count):
    msg = f"PRESENCE {name} seq={i} t={int(time.time())}".encode()
    s.sendto(msg, (bcast, port))
    time.sleep(1)
