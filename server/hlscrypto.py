"""HLS Grabber authenticated streaming AES-256-GCM file format.

Binary: b'HLSGCM1\0' (8 bytes), random 12-byte nonce, ciphertext, 16-byte GCM tag.
The fixed header is authenticated as AES-GCM AAD. Decrypt to a temporary file,
verifying the tag before publishing the plaintext output.
"""
import argparse
import base64
import os
from pathlib import Path

from cryptography.exceptions import InvalidTag
from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes

MAGIC = b"HLSGCM1\0"
NONCE_LEN = 12
TAG_LEN = 16
CHUNK = 1024 * 1024


def load_key(path):
    path = Path(path).expanduser()
    encoded = path.read_text(encoding="ascii").strip()
    key = base64.b64decode(encoded, validate=True)
    if len(key) != 32:
        raise ValueError("AES-256 requires exactly 32 bytes (base64 encoded)")
    return key


def encrypt_stream(source, destination, key, limit, on_progress=None):
    """Write encrypted bytes only; remove incomplete ciphertext upon failure."""
    nonce = os.urandom(NONCE_LEN)
    cipher = Cipher(algorithms.AES(key), modes.GCM(nonce)).encryptor()
    header = MAGIC + nonce
    cipher.authenticate_additional_data(header)
    copied = 0
    try:
        with open(destination, "xb") as out:
            os.chmod(destination, 0o600)
            out.write(header)
            while True:
                block = source.read(CHUNK)
                if not block:
                    break
                copied += len(block)
                if copied > limit:
                    raise ValueError("download exceeded configured cleartext size limit")
                out.write(cipher.update(block))
                if on_progress is not None:
                    on_progress(copied)
            out.write(cipher.finalize())
            out.write(cipher.tag)
            out.flush()
            os.fsync(out.fileno())
        return copied
    except BaseException:
        Path(destination).unlink(missing_ok=True)
        raise


def decrypt_file(source, destination, key):
    """Verify the authentication tag before exposing plaintext under final name."""
    source, destination = Path(source), Path(destination)
    temp = destination.with_name(destination.name + ".part")
    if temp.exists() or destination.exists():
        raise FileExistsError("output or temporary output already exists")
    try:
        length = source.stat().st_size
        if length < len(MAGIC) + NONCE_LEN + TAG_LEN:
            raise ValueError("truncated encrypted file")
        with source.open("rb") as inp:
            header = inp.read(len(MAGIC) + NONCE_LEN)
            if header[:len(MAGIC)] != MAGIC:
                raise ValueError("invalid HLSGCM1 header")
            nonce = header[len(MAGIC):]
            inp.seek(-TAG_LEN, os.SEEK_END)
            tag = inp.read(TAG_LEN)
            inp.seek(len(header))
            decryptor = Cipher(algorithms.AES(key), modes.GCM(nonce, tag)).decryptor()
            decryptor.authenticate_additional_data(header)
            remaining = length - len(header) - TAG_LEN
            with temp.open("xb") as out:
                os.chmod(temp, 0o600)
                while remaining:
                    block = inp.read(min(CHUNK, remaining))
                    if not block:
                        raise ValueError("truncated encrypted file")
                    remaining -= len(block)
                    out.write(decryptor.update(block))
                out.write(decryptor.finalize())
                out.flush()
                os.fsync(out.fileno())
        os.replace(temp, destination)
    except BaseException:
        temp.unlink(missing_ok=True)
        raise


def main():
    parser = argparse.ArgumentParser(description="Decrypt authenticated HLS Grabber AES-256-GCM file")
    parser.add_argument("encrypted_file")
    parser.add_argument("output_file")
    parser.add_argument("--key-file", required=True, help="Base64-encoded 32-byte key file")
    args = parser.parse_args()
    try:
        decrypt_file(args.encrypted_file, args.output_file, load_key(args.key_file))
    except (OSError, ValueError, InvalidTag) as exc:
        parser.exit(1, f"Decryption failed (bad key, corrupted file or filesystem): {exc}\n")
    print(f"Decrypted: {args.output_file}")


if __name__ == "__main__":
    main()
