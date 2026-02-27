#!/usr/bin/env python3
"""Test RTSP Digest authentication manually to debug FFmpeg 401 issues."""
import socket, hashlib, re

host = "10.10.33.32"
port = 554
uri = "/live/0582abb4-1cd7-469e-9b7c-b0c1cffab49b"
user = "adminbob"
passwd = "Test123."

sock = socket.create_connection((host, port), timeout=10)

# Send OPTIONS first
cseq = 1
req = f"OPTIONS rtsp://{host}:{port}{uri} RTSP/1.0\r\nCSeq: {cseq}\r\nUser-Agent: TestClient\r\n\r\n"
sock.sendall(req.encode())
resp = sock.recv(4096).decode(errors='replace')
print("=== OPTIONS ===")
print(resp[:300])

# Send DESCRIBE without auth to get challenge
cseq = 2
req = f"DESCRIBE rtsp://{host}:{port}{uri} RTSP/1.0\r\nCSeq: {cseq}\r\nAccept: application/sdp\r\n\r\n"
sock.sendall(req.encode())
resp = sock.recv(4096).decode(errors='replace')
print("\n=== DESCRIBE (no auth) ===")
print(resp[:500])

# Parse Digest challenge (pick MD5)
match = re.search(r'WWW-Authenticate:\s*Digest\s+realm="([^"]*)",\s*nonce="([^"]*)",\s*algorithm="MD5"', resp)
if not match:
    print("ERROR: No MD5 Digest challenge found")
    sock.close()
    exit(1)

realm = match.group(1)
nonce = match.group(2)
print(f"\nrealm={realm}, nonce={nonce}")

# Compute Digest response (RFC 2617)
describe_uri = f"rtsp://{host}:{port}{uri}"
ha1 = hashlib.md5(f"{user}:{realm}:{passwd}".encode()).hexdigest()
ha2 = hashlib.md5(f"DESCRIBE:{describe_uri}".encode()).hexdigest()
response = hashlib.md5(f"{ha1}:{nonce}:{ha2}".encode()).hexdigest()

print(f"HA1 = md5({user}:{realm}:{passwd}) = {ha1}")
print(f"HA2 = md5(DESCRIBE:{describe_uri}) = {ha2}")
print(f"response = {response}")

# Send authenticated DESCRIBE with full URI
cseq = 3
auth_header = (f'Authorization: Digest username="{user}", realm="{realm}", '
               f'nonce="{nonce}", uri="{describe_uri}", response="{response}", algorithm="MD5"')
req = f"DESCRIBE {describe_uri} RTSP/1.0\r\nCSeq: {cseq}\r\nAccept: application/sdp\r\n{auth_header}\r\n\r\n"
print(f"\n=== DESCRIBE (with MD5 auth, full URI) ===")
sock.sendall(req.encode())
resp = sock.recv(8192).decode(errors='replace')
status_line = resp.split('\r\n')[0] if resp else '(empty)'
print(f"Status: {status_line}")
print(resp[:300])

# If still 401, try with just the path as URI (some cameras expect this)
if '401' in status_line:
    sock.close()
    sock = socket.create_connection((host, port), timeout=10)
    
    # Re-do OPTIONS
    cseq = 1
    req = f"OPTIONS rtsp://{host}:{port}{uri} RTSP/1.0\r\nCSeq: {cseq}\r\n\r\n"
    sock.sendall(req.encode())
    sock.recv(4096)
    
    # Re-do DESCRIBE to get fresh nonce
    cseq = 2
    req = f"DESCRIBE rtsp://{host}:{port}{uri} RTSP/1.0\r\nCSeq: {cseq}\r\nAccept: application/sdp\r\n\r\n"
    sock.sendall(req.encode())
    resp = sock.recv(4096).decode(errors='replace')
    match = re.search(r'WWW-Authenticate:\s*Digest\s+realm="([^"]*)",\s*nonce="([^"]*)",\s*algorithm="MD5"', resp)
    if match:
        realm = match.group(1)
        nonce = match.group(2)
        
        # Use just the path (not full rtsp:// URI) in Digest computation
        ha1 = hashlib.md5(f"{user}:{realm}:{passwd}".encode()).hexdigest()
        ha2 = hashlib.md5(f"DESCRIBE:{uri}".encode()).hexdigest()
        response = hashlib.md5(f"{ha1}:{nonce}:{ha2}".encode()).hexdigest()
        
        cseq = 3
        auth_header = (f'Authorization: Digest username="{user}", realm="{realm}", '
                       f'nonce="{nonce}", uri="{uri}", response="{response}", algorithm="MD5"')
        req = f"DESCRIBE rtsp://{host}:{port}{uri} RTSP/1.0\r\nCSeq: {cseq}\r\nAccept: application/sdp\r\n{auth_header}\r\n\r\n"
        print(f"\n=== DESCRIBE (with MD5 auth, path-only URI) ===")
        print(f"HA2 = md5(DESCRIBE:{uri}) = {ha2}")
        sock.sendall(req.encode())
        resp = sock.recv(8192).decode(errors='replace')
        status_line = resp.split('\r\n')[0] if resp else '(empty)'
        print(f"Status: {status_line}")
        print(resp[:300])

sock.close()
