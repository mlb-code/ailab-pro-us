"""Print a free TCP port on 127.0.0.1 (lets QA targets run in parallel without fixed ports)."""
import socket

with socket.socket() as s:
    s.bind(('127.0.0.1', 0))
    print(s.getsockname()[1])
