# Security / Сообщения об уязвимостях

For security issues please open a private GitHub security advisory if available,
otherwise contact the repository maintainer privately. **Do not paste media URLs,
API tokens, cookies or request headers into public GitHub issues.**

## Threat model

This is a user-controlled tool, **not a public downloader-as-a-service**.
The remote service uses a randomly generated API Bearer token, listens only on
127.0.0.1 by default, and requires HTTPS or an SSH tunnel for remote access.
Treat the backend as privileged: anyone holding the API token can make it
retrieve media and consume CPU/disk/network resources.

The Python server validates the top-level URL, rejects private/reserved initial
DNS responses, rejects CR/LF header injection, and restricts FFmpeg protocols.
**It does not provide complete SSRF protection.** FFmpeg handles HTTP redirects,
HLS master playlists, nested segments, and independent DNS resolution. These
can reach internal addresses even after the original URL was validated.

**Before exposing the service on any network:** run it as an unprivileged,
dedicated user in a container/VM with *egress firewall rules* that reject new
connections to localhost, RFC1918, link-local, metadata and other internal
ranges, over both IPv4 and IPv6. Allow only required public egress ports 80/443.
Ensure DNS itself cannot reach internal services. Restrict incoming access to
an authenticated TLS reverse proxy or SSH tunnel; rate-limit there. Do not
run it on a host that has access to sensitive private networks.

FFmpeg command-line arguments contain source headers (potentially cookies and
site tokens) and can be visible to other processes with sufficient privileges.
Keep the server's account isolated and restrict process inspection.

Secrets are not intentionally persisted by the server or add-on session capture.
The user's **server** API token is saved in Firefox storage.local (not encrypted).
Delete it or rotate it if the browser profile is compromised.

No DRM bypass is provided. Only download content you are permitted to access.


## Зашифрованные загрузки (v2.2)

- Download workers now stream bytes from ffmpeg to AES-256-GCM using Python cryptography; the disk only receives authenticated-header + nonce + ciphertext + final tag. File suffix: `.hlsaes`. No full cleartext MP4/MKV temporary file is used.
- The separate AES key is stored in `~/.config/hls-grabber-server/encryption.key` mode 0600; installers never regenerate an existing key. **Losing the key means losing access to encrypted files.** The API token is not a decryption key.
- This provides encryption **at rest**, not end-to-end encryption against a compromised server: ffmpeg and Python see decrypted video in process memory, and stream URL/Cookie headers are available to the backend and its administrator. Use SSH/HTTPS for client-to-server transport.
- GCM tag validation is required when decrypting. `hlscrypto.py` writes `.part` and atomically renames only after verification. A server shutdown/power failure may leave an encrypted `.part` that cannot be decrypted; remove abandoned partial files after ensuring no worker remains.
- Job duplicate detection uses SHA-256 of the exact URL. It does not normalize changing CDN auth tokens, and the digest may be visible to an API-authorized viewer; a URL whose query parameters change may be downloaded again.
