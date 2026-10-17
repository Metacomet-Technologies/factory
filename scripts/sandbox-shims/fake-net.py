#!/usr/bin/env python3
"""Synthetic network endpoints inside the sandbox namespace; private loopback only."""
from pathlib import Path
import socket
import sys
import time

TAILNET_PORT, STATE = int(sys.argv[1]), Path(sys.argv[2])
TAILNET = STATE / "network-tailnet"


def tailnet_up():
    return not TAILNET.exists() or TAILNET.read_text().strip() == "up"


def serve_tailnet():
    """Accept and drop TCP handshakes while the fixture reads `up`; refuse them otherwise."""
    listener = None
    while True:
        if tailnet_up() and listener is None:
            listener = socket.create_server(("127.0.0.1", TAILNET_PORT))
            listener.settimeout(0.5)
        elif not tailnet_up() and listener is not None:
            listener.close()
            listener = None
        if listener is None:
            time.sleep(0.5)
            continue
        try:
            connection, _ = listener.accept()
            connection.close()
        except TimeoutError:
            pass


serve_tailnet()
